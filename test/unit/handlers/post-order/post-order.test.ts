import { Logger } from '@aws-lambda-powertools/logger'
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn'
import {
  OrderType,
  OrderValidation,
  OrderValidator,
  RelayEventWatcher,
  RelayOrderValidator,
} from '@uniswap/uniswapx-sdk'
import { mockClient } from 'aws-sdk-client-mock'
import { BigNumber } from 'ethers'
import { mock } from 'jest-mock-extended'
import { ORDER_STATUS, UniswapXOrderEntity } from '../../../../lib/entities'
import { ErrorCode } from '../../../../lib/handlers/base'
import { FillEventLogger } from '../../../../lib/handlers/check-order-status/fill-event-logger'
import { DEFAULT_MAX_OPEN_ORDERS, PRIORITY_ORDER_TARGET_BLOCK_BUFFER } from '../../../../lib/handlers/constants'
import { EventWatcherMap } from '../../../../lib/handlers/EventWatcherMap'
import { OnChainValidatorMap } from '../../../../lib/handlers/OnChainValidatorMap'
import { PostOrderHandler } from '../../../../lib/handlers/post-order/handler'
import { getMaxOpenOrders } from '../../../../lib/handlers/post-order/injector'
import { PostOrderBodyParser } from '../../../../lib/handlers/post-order/PostOrderBodyParser'
import { kickoffOrderTrackingSfn } from '../../../../lib/handlers/shared/sfn'
import { HttpStatusCode } from '../../../../lib/HttpStatusCode'
import { log } from '../../../../lib/Logging'
import { DutchV2Order } from '../../../../lib/models/DutchV2Order'
import { PriorityOrder } from '../../../../lib/models/PriorityOrder'
import { BaseOrdersRepository } from '../../../../lib/repositories/base'
import { OrderDispatcher } from '../../../../lib/services/OrderDispatcher'
import { RelayOrderService } from '../../../../lib/services/RelayOrderService'
import { UniswapXOrderService } from '../../../../lib/services/UniswapXOrderService'
import { ChainId, SUPPORTED_CHAINS } from '../../../../lib/util/chain'
import { formatOrderEntity } from '../../../../lib/util/order'
import { SDKDutchOrderFactory } from '../../../factories/SDKDutchOrderV1Factory'
import { SDKDutchOrderV2Factory } from '../../../factories/SDKDutchOrderV2Factory'
import { SDKPriorityOrderFactory } from '../../../factories/SDKPriorityOrderFactory'
import {
  COSIGNATURE,
  EVENT_CONTEXT,
  MOCK_LATEST_BLOCK,
  MOCK_PROVIDER_MAP,
  QUOTE_ID,
  REQUEST_ID,
  SIGNATURE,
} from '../../fixtures'
import { PostOrderRequestFactory } from './PostOrderRequestFactory'
import { DutchV3Order } from '../../../../lib/models/DutchV3Order'
import { SDKDutchOrderV3Factory } from '../../../factories/SDKDutchOrderV3Factory'
import { QuoteMetadataRepository } from '../../../../lib/repositories/quote-metadata-repository'

jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer', () => {
  return {
    KmsSigner: jest.fn().mockImplementation(() => {
      return {
        signDigest: jest.fn().mockResolvedValue(COSIGNATURE),
      }
    }),
  }
})

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

const MOCK_ARN_1 = 'MOCK_ARN_1'
const MOCK_ARN_42161 = 'MOCK_ARN_42161'
const MOCK_ARN_11155111 = 'MOCK_ARN_11155111'
const MOCK_HASH = '0xhash'
const MOCK_START_EXECUTION_INPUT = JSON.stringify({
  orderHash: MOCK_HASH,
  chainId: 1,
  orderStatus: ORDER_STATUS.OPEN,
})
const SAMPLE_QUOTE_METADATA = {
  quoteId: '55e2cfca-5521-4a0a-b597-7bfb569032d7',
  referencePrice: '4221.21',
  priceImpact: 0.01,
  pair: '0x0000000000000000000000000000000000000000-0x1111111111111111111111111111111111111111-123',
  blockNumber: 123456,
  route: {
    quote: '1234',
    quoteGasAdjusted: '5678',
    gasPriceWei: '1234',
    gasUseEstimateQuote: '2345',
    gasUseEstimate: '3456',
    methodParameters: {
      calldata: '0xabcdef',
      value: '1234',
      to: '0abcdef',
    },
  },
  usedUnimind: true
}

const mockSfnClient = mockClient(SFNClient)
mockSfnClient
  .on(StartExecutionCommand, {
    stateMachineArn: MOCK_ARN_1,
    name: MOCK_HASH,
    input: MOCK_START_EXECUTION_INPUT,
  })
  .resolves({})

mockSfnClient
  .on(StartExecutionCommand, {
    stateMachineArn: MOCK_ARN_11155111,
    name: MOCK_HASH,
    input: MOCK_START_EXECUTION_INPUT,
  })
  .resolves({})

describe('Testing post order handler.', () => {
  const putOrderAndUpdateNonceTransactionMock = jest.fn()
  const countOrdersByOffererAndStatusMock = jest.fn()
  const validatorMock = jest.fn()
  const onchainValidationSucceededMock = jest.fn().mockResolvedValue(OrderValidation.OK) // Ordervalidation.Ok
  const validationFailedValidatorMock = jest.fn().mockResolvedValue(OrderValidation.ValidationFailed) // OrderValidation.ValidationFailed
  const quoteMetadataRepositoryMock = mock<QuoteMetadataRepository>()

  const mockLog = mock<Logger>()
  const requestInjected = {
    requestId: 'testRequest',
    log: mockLog,
  }
  const validatorMockMapping = [
    [
      1,
      {
        validate: onchainValidationSucceededMock,
      },
    ],
    [
      42161,
      {
        validate: onchainValidationSucceededMock,
      },
    ],
    [
      11155111,
      {
        validate: onchainValidationSucceededMock,
      },
    ],
    [
      137,
      {
        validate: validationFailedValidatorMock,
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any

  const injectorPromiseMock: any = {
    getContainerInjected: () => {
      return {}
    },
    getRequestInjected: () => requestInjected,
  }

  const postOrderHandler = new PostOrderHandler(
    'post-order',
    injectorPromiseMock,
    new OrderDispatcher(
      new UniswapXOrderService(
        {
          validate: validatorMock,
        } as any,
        new OnChainValidatorMap<OrderValidator>(validatorMockMapping),
        {
          putOrderAndUpdateNonceTransaction: putOrderAndUpdateNonceTransactionMock,
          countOrdersByOffererAndStatus: countOrdersByOffererAndStatusMock,
        } as any,
        mock<BaseOrdersRepository<UniswapXOrderEntity>>(), //limit repo
        quoteMetadataRepositoryMock,
        mockLog,
        getMaxOpenOrders,
        {
          logOrderPosted: jest.fn(),
          logCancelled: jest.fn(),
          logInsufficientFunds: jest.fn(),
        },
        MOCK_PROVIDER_MAP
      ),
      new RelayOrderService(
        {
          validate: validatorMock,
        } as any,
        new OnChainValidatorMap<RelayOrderValidator>(validatorMockMapping),
        mock<EventWatcherMap<RelayEventWatcher>>(),
        {
          putOrderAndUpdateNonceTransaction: putOrderAndUpdateNonceTransactionMock,
          countOrdersByOffererAndStatus: countOrdersByOffererAndStatusMock,
        } as any,
        mockLog,
        getMaxOpenOrders,
        mock<FillEventLogger>()
      ),
      mockLog
    ),
    new PostOrderBodyParser(mockLog)
  )

  beforeAll(() => {
    process.env['STATE_MACHINE_ARN_1'] = MOCK_ARN_1
    process.env['STATE_MACHINE_ARN_42161'] = MOCK_ARN_42161
    process.env['STATE_MACHINE_ARN_11155111'] = MOCK_ARN_11155111
    process.env['REGION'] = 'region'
    process.env['KMS_KEY_ID'] = 'testtest'
    log.setLogLevel('SILENT')
  })

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => 100)
  })

  afterEach(() => {
    jest.clearAllMocks()
    mockSfnClient.reset()
  })

  describe('Testing valid request and response', () => {
    it('Testing valid request and response.', async () => {
      validatorMock.mockReturnValue({ valid: true })

      const order = SDKDutchOrderFactory.buildDutchOrder()
      const expectedOrderEntity = formatOrderEntity(order, SIGNATURE, OrderType.Dutch, ORDER_STATUS.OPEN, QUOTE_ID)

      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.serialize(),
          signature: SIGNATURE,
          quoteId: QUOTE_ID,
        }),
        EVENT_CONTEXT
      )

      expect(postOrderResponse.statusCode).toEqual(HttpStatusCode.Created)

      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(expectedOrderEntity)
      expect(onchainValidationSucceededMock).toBeCalled()
      expect(validatorMock).toBeCalledWith(order)
      expect(mockSfnClient.calls()).toHaveLength(1)
      expect(mockSfnClient.call(0).args[0].input).toMatchObject({
        stateMachineArn: MOCK_ARN_1,
        input:
          '{"orderHash":"0x4ab4f60562fadec8a074b65c834c0414f990ac51742d4fe96c2271d22aeba6b2","chainId":1,"orderStatus":"open","quoteId":"55e2cfca-5521-4a0a-b597-7bfb569032d7","orderType":"Dutch","stateMachineArn":"MOCK_ARN_1"}',
      })

      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ hash: expectedOrderEntity.orderHash }),
        statusCode: HttpStatusCode.Created,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('Testing valid request and response for Dutch_V2', async () => {
      validatorMock.mockReturnValue({ valid: true })

      const order = new DutchV2Order(
        SDKDutchOrderV2Factory.buildDutchV2Order(),
        SIGNATURE,
        1,
        undefined,
        undefined,
        undefined,
        REQUEST_ID
      )
      const expectedOrderEntity = order.toEntity(ORDER_STATUS.OPEN)

      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.inner.serialize(),
          signature: SIGNATURE,
          orderType: OrderType.Dutch_V2,
        }),
        EVENT_CONTEXT
      )

      expect(postOrderResponse.statusCode).toEqual(HttpStatusCode.Created)

      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(
        expect.objectContaining({
          ...expectedOrderEntity,
          quoteId: expect.any(String),
          requestId: expect.any(String),
        })
      )
      expect(onchainValidationSucceededMock).toBeCalled()
      expect(validatorMock).toBeCalledWith(order.inner)
      expect(mockSfnClient.calls()).toHaveLength(1)
      expect(mockSfnClient.call(0).args[0].input).toMatchObject({
        stateMachineArn: MOCK_ARN_1,
      })

      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ hash: expectedOrderEntity.orderHash }),
        statusCode: HttpStatusCode.Created,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('Testing valid request and response for Priority', async () => {
      validatorMock.mockReturnValue({ valid: true })

      const order = new PriorityOrder(
        SDKPriorityOrderFactory.buildPriorityOrder(),
        SIGNATURE,
        1,
        undefined,
        undefined,
        undefined,
        REQUEST_ID
      )

      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.inner.serialize(),
          signature: SIGNATURE,
          orderType: OrderType.Priority,
        }),
        EVENT_CONTEXT
      )

      // cosignature and cosignerData gets overwritten within the handler
      order.inner.info.cosignature = COSIGNATURE
      order.inner.info.cosignerData = {
        auctionTargetBlock: BigNumber.from(MOCK_LATEST_BLOCK + PRIORITY_ORDER_TARGET_BLOCK_BUFFER[order.chainId as ChainId]),
      }
      const expectedOrderEntity = order.toEntity(ORDER_STATUS.OPEN)
      expect(postOrderResponse.statusCode).toEqual(HttpStatusCode.Created)

      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(
        expect.objectContaining({
          ...expectedOrderEntity,
          quoteId: expect.any(String),
          requestId: expect.any(String),
          cosignature: COSIGNATURE,
          cosignerData: {
            // MOCK_LATEST_BLOCK + 3
            auctionTargetBlock: 103,
          },
        })
      )
      expect(onchainValidationSucceededMock).toBeCalled()
      expect(validatorMock).toBeCalledWith(order.inner)
      expect(mockSfnClient.calls()).toHaveLength(1)
      expect(mockSfnClient.call(0).args[0].input).toMatchObject({
        stateMachineArn: MOCK_ARN_1,
      })

      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ hash: expectedOrderEntity.orderHash }),
        statusCode: HttpStatusCode.Created,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('Testing valid request and response for Dutch_V3', async () => {
      validatorMock.mockReturnValue({ valid: true })

      const order = new DutchV3Order(
        SDKDutchOrderV3Factory.buildDutchV3Order(),
        SIGNATURE,
        ChainId.ARBITRUM_ONE,
        undefined,
        undefined,
        undefined,
        REQUEST_ID
      )
      const expectedOrderEntity = order.toEntity(ORDER_STATUS.OPEN)

      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.inner.serialize(),
          signature: SIGNATURE,
          orderType: OrderType.Dutch_V3,
          chainId: ChainId.ARBITRUM_ONE,
        }),
        EVENT_CONTEXT
      )
      expect(postOrderResponse.statusCode).toEqual(HttpStatusCode.Created)

      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(
        expect.objectContaining({
          ...expectedOrderEntity,
          quoteId: expect.any(String),
          requestId: REQUEST_ID,
        })
      )
      expect(onchainValidationSucceededMock).toBeCalled()
      expect(validatorMock).toBeCalledWith(order.inner)
      expect(mockSfnClient.calls()).toHaveLength(1)
      expect(mockSfnClient.call(0).args[0].input).toMatchObject({
        stateMachineArn: MOCK_ARN_42161,
      })

      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ hash: expectedOrderEntity.orderHash }),
        statusCode: HttpStatusCode.Created,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('Testing valid request and response on another chain', async () => {
      validatorMock.mockReturnValue({ valid: true })

      const order = SDKDutchOrderFactory.buildDutchOrder(ChainId.SEPOLIA)
      const expectedOrderEntity = formatOrderEntity(order, SIGNATURE, OrderType.Dutch, ORDER_STATUS.OPEN, QUOTE_ID)

      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.serialize(),
          signature: SIGNATURE,
          quoteId: QUOTE_ID,
          chainId: ChainId.SEPOLIA,
        }),
        EVENT_CONTEXT
      )
      expect(postOrderResponse.statusCode).toEqual(HttpStatusCode.Created)

      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(expectedOrderEntity)
      expect(onchainValidationSucceededMock).toBeCalled()
      expect(validatorMock).toBeCalledWith(order)
      expect(mockSfnClient.calls()).toHaveLength(1)
      expect(mockSfnClient.call(0).args[0].input).toMatchObject({
        stateMachineArn: MOCK_ARN_11155111,
      })
      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ hash: expectedOrderEntity.orderHash }),
        statusCode: HttpStatusCode.Created,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('Attaches quote metadata to DutchV3 order when available', async () => {
      validatorMock.mockReturnValue({ valid: true })
      countOrdersByOffererAndStatusMock.mockResolvedValue(0)
  
      quoteMetadataRepositoryMock.getByQuoteId.mockResolvedValue(SAMPLE_QUOTE_METADATA)
    
      const QUOTE_ID = SAMPLE_QUOTE_METADATA.quoteId
    
      const sdkOrder = SDKDutchOrderV3Factory.buildDutchV3Order(ChainId.ARBITRUM_ONE)
      const order = new DutchV3Order(
        sdkOrder,
        SIGNATURE,
        ChainId.ARBITRUM_ONE,
        ORDER_STATUS.OPEN,
        undefined,
        undefined,
        QUOTE_ID,
        REQUEST_ID
      )
      
      await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.inner.serialize(),
          signature: SIGNATURE,
          orderType: OrderType.Dutch_V3,
          quoteId: QUOTE_ID,
          chainId: ChainId.ARBITRUM_ONE,
        }),
        EVENT_CONTEXT
      )
    
      const expectedOrderEntity = order.toEntity(ORDER_STATUS.OPEN, SAMPLE_QUOTE_METADATA)
      expect(putOrderAndUpdateNonceTransactionMock).toHaveBeenCalledWith(expectedOrderEntity)
      expect(quoteMetadataRepositoryMock.getByQuoteId).toHaveBeenCalledWith(QUOTE_ID)
    })
  })

  describe('Test order submission blocking', () => {
    describe('Max open orders', () => {
      it('should reject order submission for offerer when too many open orders exist', async () => {
        countOrdersByOffererAndStatusMock.mockReturnValueOnce(DEFAULT_MAX_OPEN_ORDERS + 1)
        validatorMock.mockReturnValue({ valid: true })

        const order = SDKDutchOrderFactory.buildDutchOrder()
        const response = await postOrderHandler.handler(
          PostOrderRequestFactory.request({
            encodedOrder: order.serialize(),
            signature: SIGNATURE,
            quoteId: QUOTE_ID,
          }),
          EVENT_CONTEXT
        )
        expect(response.statusCode).toEqual(HttpStatusCode.Forbidden)

        expect(response).toMatchObject({
          body: JSON.stringify({
            errorCode: ErrorCode.TooManyOpenOrders,
            id: 'testRequest',
          }),
          statusCode: HttpStatusCode.Forbidden,
        })
        expect(countOrdersByOffererAndStatusMock).toBeCalled()
        expect(onchainValidationSucceededMock).toBeCalled()
        expect(putOrderAndUpdateNonceTransactionMock).not.toBeCalled()
      })

      it('should allow more orders if in the high list', async () => {
        countOrdersByOffererAndStatusMock.mockReturnValueOnce(100)
        validatorMock.mockReturnValue({ valid: true })

        const order = SDKDutchOrderFactory.buildDutchOrder(ChainId.MAINNET, {
          swapper: '0xa7152fad7467857dc2d4060fecaadf9f6b8227d3',
        })

        const response = await postOrderHandler.handler(
          PostOrderRequestFactory.request({
            encodedOrder: order.serialize(),
          }),
          EVENT_CONTEXT
        )
        expect(response).toMatchObject({
          statusCode: HttpStatusCode.Created,
        })
        expect(countOrdersByOffererAndStatusMock).toBeCalled()
        expect(onchainValidationSucceededMock).toBeCalled()
        expect(putOrderAndUpdateNonceTransactionMock).toBeCalled()
      })

      it('should reject order submission for offerer in high list at higher order count', async () => {
        countOrdersByOffererAndStatusMock.mockReturnValueOnce(201)
        validatorMock.mockReturnValue({ valid: true })

        const order = SDKDutchOrderFactory.buildDutchOrder(ChainId.MAINNET, {
          swapper: '0xa7152fad7467857dc2d4060fecaadf9f6b8227d3',
        })

        expect(
          await postOrderHandler.handler(
            PostOrderRequestFactory.request({
              encodedOrder: order.serialize(),
            }),
            EVENT_CONTEXT
          )
        ).toMatchObject({
          body: JSON.stringify({
            errorCode: ErrorCode.TooManyOpenOrders,
            id: 'testRequest',
          }),
          statusCode: HttpStatusCode.Forbidden,
        })
        expect(countOrdersByOffererAndStatusMock).toBeCalled()
        expect(onchainValidationSucceededMock).toBeCalled()
        expect(putOrderAndUpdateNonceTransactionMock).not.toBeCalled()
      })
    })

    it('should return 500 if DDB call throws', async () => {
      const order = SDKDutchOrderFactory.buildDutchOrder()
      countOrdersByOffererAndStatusMock.mockRejectedValueOnce(new Error('DDB error'))
      expect(
        await postOrderHandler.handler(
          PostOrderRequestFactory.request({
            encodedOrder: order.serialize(),
          }),
          EVENT_CONTEXT
        )
      ).toMatchObject({
        statusCode: HttpStatusCode.InternalServerError,
      })
    })

    it('should fail if tokenIn = address(0)', async () => {
      validatorMock.mockReturnValue({ valid: true })
      const order = SDKDutchOrderFactory.buildDutchOrder(ChainId.MAINNET, {
        input: {
          token: '0x0000000000000000000000000000000000000000',
          endAmount: '30',
          startAmount: '30',
        },
      })
      expect(
        await postOrderHandler.handler(
          PostOrderRequestFactory.request({
            encodedOrder: order.serialize(),
          }),
          EVENT_CONTEXT
        )
      ).toMatchObject({
        body: JSON.stringify({
          errorCode: ErrorCode.InvalidTokenInAddress,
          id: 'testRequest',
        }),
        statusCode: HttpStatusCode.BadRequest,
      })
    })
  })

  describe('Testing invalid request validation.', () => {
    it.each([
      [
        { encodedOrder: '0xbad_order' },
        '{"detail":"\\"encodedOrder\\" with value \\"0xbad_order\\" fails to match the required pattern: /^0x[0-9,a-z,A-Z]{0,4000}$/","errorCode":"VALIDATION_ERROR"}',
      ],
      [
        { signature: '0xbad_signature' },
        '{"detail":"\\"signature\\" with value \\"0xbad_signature\\" fails to match the required pattern: /^0x[0-9,a-z,A-Z]{130}$/","errorCode":"VALIDATION_ERROR"}',
      ],
      [
        { chainId: 0 },
        `{"detail":"\\"chainId\\" must be one of [${SUPPORTED_CHAINS.join(', ')}]","errorCode":"VALIDATION_ERROR"}`,
      ],
      [{ quoteId: 'not_UUIDV4' }, '{"detail":"\\"quoteId\\" must be a valid GUID","errorCode":"VALIDATION_ERROR"}'],
    ])('Throws 400 with invalid field %p', async (invalidBodyField, bodyMsg) => {
      const invalidEvent = PostOrderRequestFactory.request({
        ...invalidBodyField,
      })
      const postOrderResponse = await postOrderHandler.handler(invalidEvent, EVENT_CONTEXT)
      expect(postOrderResponse.statusCode).toEqual(400)
      expect(postOrderResponse.body).toEqual(expect.stringContaining(bodyMsg))
      expect(postOrderResponse.body).toEqual(expect.stringContaining('VALIDATION_ERROR'))
      expect(validatorMock).not.toHaveBeenCalled()
      expect(putOrderAndUpdateNonceTransactionMock).not.toHaveBeenCalled()
    })

    it('should call StepFunctions.startExecution method with the correct params', async () => {
      const sfnInput = {
        orderHash: '0xhash',
        chainId: ChainId.MAINNET,
        quoteId: 'quoteId',
        orderStatus: ORDER_STATUS.OPEN,
        orderType: OrderType.Dutch,
        stateMachineArn: MOCK_ARN_1,
      }
      expect(async () => await kickoffOrderTrackingSfn(sfnInput, MOCK_ARN_1)).not.toThrow()
      expect(mockSfnClient.calls()).toHaveLength(1)

      expect(mockSfnClient.call(0).args[0].input).toStrictEqual(
        new StartExecutionCommand({
          stateMachineArn: MOCK_ARN_1,
          input: JSON.stringify(sfnInput),
          name: expect.any(String),
        }).input
      )
    })
  })

  describe('Testing invalid response validation.', () => {
    it('Throws 500 when db interface errors out.', async () => {
      putOrderAndUpdateNonceTransactionMock.mockImplementation(() => {
        throw new Error('database unavailable')
      })

      validatorMock.mockReturnValue({ valid: true })

      const order = SDKDutchOrderFactory.buildDutchOrder()
      const expectedOrderEntity = formatOrderEntity(order, SIGNATURE, OrderType.Dutch, ORDER_STATUS.OPEN, QUOTE_ID)
      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.serialize(),
          signature: SIGNATURE,
          quoteId: QUOTE_ID,
        }),
        EVENT_CONTEXT
      )
      expect(putOrderAndUpdateNonceTransactionMock).toBeCalledWith(expectedOrderEntity)
      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ detail: 'database unavailable', errorCode: ErrorCode.InternalError, id: 'testRequest' }),
        statusCode: HttpStatusCode.InternalServerError,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })
  })

  describe('When validation fails', () => {
    it('off-chain validation failed; throws 400', async () => {
      const errorCode = ErrorCode.InvalidOrder
      const errorString = 'testing offchain validation'
      validatorMock.mockReturnValue({
        valid: false,
        errorString,
      })
      const order = SDKDutchOrderFactory.buildDutchOrder()
      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          encodedOrder: order.serialize(),
        }),
        EVENT_CONTEXT
      )
      expect(putOrderAndUpdateNonceTransactionMock).not.toHaveBeenCalled()
      expect(postOrderResponse).toEqual({
        body: JSON.stringify({ detail: errorString, errorCode, id: 'testRequest' }),
        statusCode: HttpStatusCode.BadRequest,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })

    it('on-chain validation failed; throws 400', async () => {
      const order = SDKDutchOrderFactory.buildDutchOrder(ChainId.POLYGON)
      validatorMock.mockReturnValue({
        valid: true,
      })
      const postOrderResponse = await postOrderHandler.handler(
        PostOrderRequestFactory.request({
          chainId: ChainId.POLYGON,
          encodedOrder: order.serialize(),
        }),
        EVENT_CONTEXT
      )
      expect(putOrderAndUpdateNonceTransactionMock).not.toHaveBeenCalled()
      expect(postOrderResponse).toEqual({
        body: JSON.stringify({
          detail: `Onchain validation failed: ValidationFailed`,
          errorCode: ErrorCode.InvalidOrder,
          id: 'testRequest',
        }),
        statusCode: HttpStatusCode.BadRequest,
        headers: {
          'Access-Control-Allow-Credentials': true,
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      })
    })
  })
})
