import { Unit } from 'aws-embedded-metrics'
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda'
import dotenv from 'dotenv'
import Joi from 'joi'
import fetch from 'node-fetch'
import { UniswapXOrderEntity } from '../../entities'
import { OrderDispatcher } from '../../services/OrderDispatcher'
import { log } from '../../util/log'
import { metrics } from '../../util/metrics'
import {
  APIGLambdaHandler,
  APIHandleRequestParams,
  ApiInjector,
  ErrorCode,
  ErrorResponse,
  Response,
} from '../base/index'
import { ContainerInjected, RequestInjected } from './injector'
import { GetDutchV2OrderResponse } from './schema/GetDutchV2OrderResponse'
import { GetDutchV3OrderResponse } from './schema/GetDutchV3OrderResponse'
import { GetOrdersResponse, GetOrdersResponseJoi } from './schema/GetOrdersResponse'
import { GetPriorityOrderResponse } from './schema/GetPriorityOrderResponse'
import { GetRelayOrderResponse, GetRelayOrdersResponseJoi } from './schema/GetRelayOrderResponse'
import { GetOrdersQueryParams, GetOrdersQueryParamsJoi, RawGetOrdersQueryParams } from './schema/index'

dotenv.config()

export class GetOrdersHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  void,
  RawGetOrdersQueryParams,
  GetOrdersResponse<
    | UniswapXOrderEntity
    | GetDutchV2OrderResponse
    | GetDutchV3OrderResponse
    | GetRelayOrderResponse
    | GetPriorityOrderResponse
    | undefined
  >
> {
  constructor(
    handlerName: string,
    injectorPromise: Promise<ApiInjector<ContainerInjected, RequestInjected, void, RawGetOrdersQueryParams>>,
    private readonly orderDispatcher: OrderDispatcher
  ) {
    super(handlerName, injectorPromise)
  }

  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, void, RawGetOrdersQueryParams>
  ): Promise<
    | Response<
        GetOrdersResponse<
          | UniswapXOrderEntity
          | GetDutchV2OrderResponse
          | GetDutchV3OrderResponse
          | GetRelayOrderResponse
          | GetPriorityOrderResponse
          | undefined
        >
      >
    | ErrorResponse
  > {
    const {
      requestInjected: { limit, queryFilters, cursor, orderType, executeAddress },
      containerInjected: { dbInterface },
    } = params

    this.logMetrics(queryFilters)

    try {
      if (orderType) {
        const getOrdersResult = await this.orderDispatcher.getOrder(orderType, {
          limit,
          params: queryFilters,
          cursor,
          executeAddress,
        })

        log.info({ getOrdersResult }, 'Get orders result before token metadata')

        // mapping the token symbol and decimals to the order
        let tokenAddresses: string[] = []
        getOrdersResult.orders.map((order: any) => {
          if (order.input.token) {
            tokenAddresses.push(order.input.token)
          }
          if (order.outputs.length > 0) {
            order.outputs.forEach((output: any) => {
              tokenAddresses.push(output.token)
            })
          }
        })

        log.info({ tokenAddresses }, 'Token addresses before deduplication')

        // remove duplicates from tokenAddresses
        tokenAddresses = [...new Set(tokenAddresses)]

        log.info({ tokenAddresses }, 'Token addresses after deduplication')

        // get the token metadata
        const tokenMetadata = await this.getTokenMetadata(tokenAddresses)

        log.info({ tokenMetadata }, 'Token metadata')

        // add the token metadata to the order
        const orders = getOrdersResult.orders.map((order: any) => {
          if (order.input.token) {
            order.input.symbol = tokenMetadata.get(order.input.token)?.symbol
            order.input.decimals = tokenMetadata.get(order.input.token)?.decimals
          }
          if (order.outputs.length > 0) {
            order.outputs.forEach((output: any) => {
              output.symbol = tokenMetadata.get(output.token)?.symbol
              output.decimals = tokenMetadata.get(output.token)?.decimals
            })
          }
          return order
        })

        log.info({ orders }, 'Orders with token metadata')

        getOrdersResult.orders = orders

        log.info({ getOrdersResult }, 'Get orders result')

        return {
          statusCode: 200,
          body: getOrdersResult,
        }
      }

      //without orderType specified, keep legacy implementation
      const getOrdersResult = await dbInterface.getOrders(limit, queryFilters, cursor)

      return {
        statusCode: 200,
        body: {
          // w/o specifying orderType, the orderDispatcher uses the legacy get implementation
          //   and for priority orders, the returned object will contain offerer instead of swapper
          orders: getOrdersResult.orders.map((order: any) => {
            if (order.offerer) {
              const { offerer, ...rest } = order
              return {
                ...rest,
                swapper: offerer,
              }
            }
            return order
          }),
          cursor: getOrdersResult.cursor,
        },
      }
    } catch (e: unknown) {
      // TODO: differentiate between input errors and add logging if unknown is not type Error
      return {
        statusCode: 500,
        errorCode: ErrorCode.InternalError,
        ...(e instanceof Error && { detail: e.message }),
      }
    }
  }

  private logMetrics(queryFilters: GetOrdersQueryParams) {
    // This log is used for generating a metrics dashboard, do not modify.
    log.info({ queryFiltersSorted: Object.keys(queryFilters).sort().join(',') }, 'Get orders query filters for metrics')
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return null
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return GetOrdersQueryParamsJoi
  }

  protected responseBodySchema(): Joi.Schema | null {
    return Joi.alternatives(GetOrdersResponseJoi, GetRelayOrdersResponseJoi)
  }

  protected afterResponseHook(event: APIGatewayProxyEvent, _context: Context, response: APIGatewayProxyResult): void {
    const { statusCode } = response

    // Try and extract the chain id from the raw json.
    let chainId = '0'
    try {
      const rawBody = JSON.parse(event.body!)
      chainId = rawBody.chainId ?? chainId
    } catch (err) {
      // no-op. If we can't get chainId still log the metric as chain 0
    }
    const statusCodeMod = (Math.floor(statusCode / 100) * 100).toString().replace(/0/g, 'X')

    const getOrdersByChainMetricName = `GetOrdersChainId${chainId.toString()}Status${statusCodeMod}`
    metrics.putMetric(getOrdersByChainMetricName, 1, Unit.Count)

    const getOrdersMetricName = `GetOrdersStatus${statusCodeMod}`
    metrics.putMetric(getOrdersMetricName, 1, Unit.Count)

    const getOrdersRequestMetricName = `GetOrdersRequest`
    metrics.putMetric(getOrdersRequestMetricName, 1, Unit.Count)

    const getOrdersRequestByChainIdMetricName = `GetOrdersRequestChainId${chainId.toString()}`
    metrics.putMetric(getOrdersRequestByChainIdMetricName, 1, Unit.Count)
  }

  private async getTokenMetadata(tokenAddresses: string[]) {
    if (process.env.MIMBOKU_V3_GRAPHQL_URL === undefined) {
      throw new Error(`Environmental variable MIMBOKU_V3_GRAPHQL_URL isn't defined!`)
    }
    if (process.env.MIMBOKU_V2_GRAPHQL_URL === undefined) {
      throw new Error(`Environmental variable MIMBOKU_V2_GRAPHQL_URL isn't defined!`)
    }
    const URL_V3 = process.env.MIMBOKU_V3_GRAPHQL_URL!
    const URL_V2 = process.env.MIMBOKU_V2_GRAPHQL_URL!
    const mapTokenToMetadata = new Map<string, { symbol: string; decimals: number }>()

    log.info({ URL_V3, URL_V2 }, 'URLs')

    const query = `
      query GetTokenMetadata($tokens: [String!]!) {
        tokens(where: { id_in: $tokens }) {
          id
          symbol
          decimals
        }
      }
    `

    try {
      // Fetch from V3 subgraph
      const v3Response = await fetch(URL_V3, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { tokens: tokenAddresses } }),
      })

      log.info({ v3Response }, 'V3 subgraph response')

      if (!v3Response.ok) {
        throw new Error(`V3 subgraph request failed: ${v3Response.statusText}`)
      }

      const v3Data = await v3Response.json()
      log.info({ v3Data }, 'V3 subgraph response')
      v3Data.data.tokens.forEach((token: { id: string; symbol: string; decimals: number }) => {
        mapTokenToMetadata.set(token.id.toLowerCase(), {
          symbol: token.symbol,
          decimals: token.decimals,
        })
      })

      // Fetch from V2 subgraph
      const v2Response = await fetch(URL_V2, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { tokens: tokenAddresses } }),
      })

      log.info({ v2Response }, 'V2 subgraph response')

      if (!v2Response.ok) {
        throw new Error(`V2 subgraph request failed: ${v2Response.statusText}`)
      }

      const v2Data = await v2Response.json()
      log.info({ v2Data }, 'V2 subgraph response')

      v2Data.data.tokens.forEach((token: { id: string; symbol: string; decimals: number }) => {
        const tokenId = token.id.toLowerCase()
        if (!mapTokenToMetadata.has(tokenId)) {
          mapTokenToMetadata.set(tokenId, {
            symbol: token.symbol,
            decimals: token.decimals,
          })
        }
      })

      return mapTokenToMetadata
    } catch (error) {
      log.error({ error, tokenAddresses }, 'Failed to fetch token metadata from subgraphs')
      throw error
    }
  }
}
