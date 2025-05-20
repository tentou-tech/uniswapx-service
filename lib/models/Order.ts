import { OrderType } from '@tentou-tech/uniswapx-sdk'

export abstract class Order {
  abstract get orderType(): OrderType
}
