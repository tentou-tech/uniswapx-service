import { OrderType } from '@tentou-tech/uniswapx-sdk'

export class NoHandlerConfiguredError extends Error {
  constructor(orderType: OrderType) {
    super(`No handler configured for orderType: ${orderType}`)
  }
}
