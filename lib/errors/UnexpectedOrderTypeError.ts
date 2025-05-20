import { OrderType } from '@tentou-tech/uniswapx-sdk'

export class UnexpectedOrderTypeError extends Error {
  constructor(orderType: OrderType) {
    super(`Unexpected orderType: ${orderType}`)
  }
}
