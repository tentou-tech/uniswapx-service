import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { KmsSigner } from '@uniswap/signer'
import { CosignedPriorityOrder as SDKPriorityOrder, OrderType } from '@uniswap/uniswapx-sdk'
import { BigNumber } from 'ethers'
import { ORDER_STATUS, PriorityOrderEntity, UniswapXOrderEntity } from '../entities'
import { PRIORITY_ORDER_TARGET_BLOCK_BUFFER } from '../handlers/constants'
import { GetPriorityOrderResponse } from '../handlers/get-orders/schema/GetPriorityOrderResponse'
import { Order } from './Order'
import { QuoteMetadata, Route } from '../repositories/quote-metadata-repository'
import { artemisModifyCalldata } from '../util/UniversalRouterCalldata'
import { Logger } from '@aws-lambda-powertools/logger'
import { ChainId } from '../util/chain'

export class PriorityOrder extends Order {
  constructor(
    readonly inner: SDKPriorityOrder,
    readonly signature: string,
    readonly chainId: number,
    readonly orderStatus?: ORDER_STATUS,
    readonly txHash?: string,
    readonly quoteId?: string,
    readonly requestId?: string,
    readonly createdAt?: number,
    readonly settledAmounts?: {
      tokenOut: string
      amountOut: string
      tokenIn: string
      amountIn: string
    }[],
    readonly route?: Route
  ) {
    super()
  }

  get orderType(): OrderType {
    return OrderType.Priority
  }

  public toEntity(orderStatus: ORDER_STATUS, quoteMetadata?: QuoteMetadata): PriorityOrderEntity {
    const { input, outputs } = this.inner.info
    const decodedOrder = this.inner
    const order: PriorityOrderEntity = {
      type: OrderType.Priority,
      encodedOrder: decodedOrder.serialize(),
      signature: this.signature,
      nonce: decodedOrder.info.nonce.toString(),
      orderHash: decodedOrder.hash().toLowerCase(),
      chainId: decodedOrder.chainId,
      orderStatus: orderStatus,
      offerer: decodedOrder.info.swapper.toLowerCase(),
      auctionStartBlock: decodedOrder.info.auctionStartBlock.toNumber(),
      baselinePriorityFeeWei: decodedOrder.info.baselinePriorityFeeWei.toString(),
      input: {
        token: input.token,
        amount: input.amount.toString(),
        mpsPerPriorityFeeWei: input.mpsPerPriorityFeeWei.toString(),
      },
      outputs: outputs.map((output) => ({
        token: output.token,
        amount: output.amount.toString(),
        mpsPerPriorityFeeWei: output.mpsPerPriorityFeeWei.toString(),
        recipient: output.recipient.toLowerCase(),
      })),
      reactor: decodedOrder.info.reactor.toLowerCase(),
      deadline: decodedOrder.info.deadline,
      cosignerData: {
        auctionTargetBlock: decodedOrder.info.cosignerData.auctionTargetBlock.toNumber(),
      },
      txHash: this.txHash,
      cosignature: decodedOrder.info.cosignature,
      quoteId: this.quoteId,
      requestId: this.requestId,
      createdAt: this.createdAt,
      referencePrice: quoteMetadata?.referencePrice,
      priceImpact: quoteMetadata?.priceImpact,
      blockNumber: quoteMetadata?.blockNumber,
      route: quoteMetadata?.route,
      pair: quoteMetadata?.pair,
    }

    return order
  }

  public static fromEntity(entity: UniswapXOrderEntity, log: Logger, executeAddress?: string): PriorityOrder {
    const route = executeAddress && entity.route ? {
      quote: entity.route.quote,
      quoteGasAdjusted: entity.route.quoteGasAdjusted,
      gasPriceWei: entity.route.gasPriceWei,
      gasUseEstimateQuote: entity.route.gasUseEstimateQuote,
      gasUseEstimate: entity.route.gasUseEstimate,
      methodParameters : {
        calldata: artemisModifyCalldata(entity.route.methodParameters.calldata, log, executeAddress),
        value: entity.route.methodParameters.value,
        to: entity.route.methodParameters.to,
      },
    } : entity.route
    return new PriorityOrder(
      SDKPriorityOrder.parse(entity.encodedOrder, entity.chainId),
      entity.signature,
      entity.chainId,
      entity.orderStatus,
      entity.txHash,
      entity.quoteId,
      entity.requestId,
      entity.createdAt,
      entity.settledAmounts,
      route
    )
  }

  public async reparameterizeAndCosign(provider: StaticJsonRpcProvider, cosigner: KmsSigner): Promise<this> {
    const currentBlock = await provider.getBlockNumber()
    this.inner.info.cosignerData = {
      auctionTargetBlock: BigNumber.from(currentBlock).add(PRIORITY_ORDER_TARGET_BLOCK_BUFFER[this.chainId as ChainId]),
    }

    this.inner.info.cosignature = await cosigner.signDigest(this.inner.cosignatureHash(this.inner.info.cosignerData))
    return this
  }

  public toGetResponse(): GetPriorityOrderResponse {
    return {
      type: OrderType.Priority,
      orderStatus: this.orderStatus as ORDER_STATUS,
      signature: this.signature,
      encodedOrder: this.inner.serialize(),
      chainId: this.chainId,
      nonce: this.inner.info.nonce.toString(),
      txHash: this.txHash,
      orderHash: this.inner.hash(),
      swapper: this.inner.info.swapper,
      reactor: this.inner.info.reactor,
      deadline: this.inner.info.deadline,
      auctionStartBlock: this.inner.info.auctionStartBlock.toNumber(),
      baselinePriorityFeeWei: this.inner.info.baselinePriorityFeeWei.toString(),
      input: {
        token: this.inner.info.input.token,
        amount: this.inner.info.input.amount.toString(),
        mpsPerPriorityFeeWei: this.inner.info.input.mpsPerPriorityFeeWei.toString(),
      },
      outputs: this.inner.info.outputs.map((o) => {
        return {
          token: o.token,
          amount: this.inner.info.input.amount.toString(),
          mpsPerPriorityFeeWei: this.inner.info.input.mpsPerPriorityFeeWei.toString(),
          recipient: o.recipient,
        }
      }),
      settledAmounts: this.settledAmounts,
      cosignerData: {
        auctionTargetBlock: this.inner.info.cosignerData.auctionTargetBlock.toNumber(),
      },
      cosignature: this.inner.info.cosignature,
      quoteId: this.quoteId,
      requestId: this.requestId,
      createdAt: this.createdAt,
      route: this.route,
    }
  }
}
