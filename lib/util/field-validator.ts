// import { OrderType } from '@uniswap/uniswapx-sdk'
import { OrderType } from '@uniswap/uniswapx-sdk'
import dotenv from 'dotenv'
import { BigNumber, ethers } from 'ethers'
import Joi, { CustomHelpers, NumberSchema, StringSchema } from 'joi'
import { ORDER_STATUS, SORT_FIELDS } from '../entities'
import { checkDefined } from '../preconditions/preconditions'
import { SUPPORTED_CHAINS } from './chain'
import { DUTCH_LIMIT } from './order'

dotenv.config()

export const SORT_REGEX = /(\w+)\(([0-9]+)(?:,([0-9]+))?\)/
const UINT256_MAX = BigNumber.from(1).shl(256).sub(1)

// Lazy load environment variables
function getEnvVar(name: string): string {
  return checkDefined(process.env[name], `${name} is not defined`)
}

export default class FieldValidator {
  private static readonly ENCODED_ORDER_JOI = Joi.string().regex(this.getHexiDecimalRegex(4000, true))
  private static readonly SIGNATURE_JOI = Joi.string().regex(this.getHexiDecimalRegex(130))
  private static readonly ORDER_HASH_JOI = Joi.string().regex(this.getHexiDecimalRegex(64))
  private static readonly ORDER_HASHES_JOI = Joi.string()
    .regex(new RegExp(`^(?=([^,]*,){0,49}[^,]*$)0x[0-9a-zA-Z]{64}(,0x[0-9a-zA-Z]{64})*$`))
    .message(
      'Invalid input. Expected comma-separated order hashes, with a maximum of 50, each matching the pattern "^0x[0-9a-zA-Z]{64}$".'
    )
  private static readonly TX_HASH_JOI = Joi.string().regex(this.getHexiDecimalRegex(64))
  private static readonly UUIDV4_JOI = Joi.string().guid({
    version: ['uuidv4'],
  })
  private static readonly BIG_NUMBER_JOI = Joi.string()
    .min(1)
    .max(78) // 2^256 - 1 in base 10 is 78 digits long
    .regex(/^[0-9]+$/)
    .custom((value: string, helpers: CustomHelpers<any>) => {
      if (!BigNumber.from(value).lt(UINT256_MAX)) {
        return helpers.error('VALIDATION ERROR: Nonce is larger than max uint256 integer')
      }
      return value
    })
  private static readonly BIG_INT_STRING_JOI = Joi.string()
    .min(1)
    .max(78) // Same max length as BigNumber
    .regex(/^-?[0-9]+$/) // Allow negative sign followed by digits
    .custom((value: string, helpers: CustomHelpers<any>) => {
      try {
        // Verify it can be parsed as a BigInt
        BigInt(value);
        return value;
      } catch (error) {
        return helpers.error('VALIDATION ERROR: Value cannot be parsed as a BigInt')
      }
    })
  private static readonly NUMBER_JOI = Joi.number()
  private static readonly BASE_64_STRING = Joi.string().max(500).base64()
  private static readonly CHAIN_ID_JOI = Joi.number().valid(...SUPPORTED_CHAINS)
  private static readonly ORDER_STATUS_JOI = Joi.string().valid(
    ORDER_STATUS.OPEN,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.ERROR,
    ORDER_STATUS.INSUFFICIENT_FUNDS
  )
  private static readonly SORT_KEY_JOI = Joi.string().valid(SORT_FIELDS.CREATED_AT)
  private static readonly SORT_JOI = Joi.string().regex(SORT_REGEX)

  // TODO: DutchLimit type is deprecated but we allow it in the response to remain backwards compatible.
  // Remove this field from Joi once we have purge job to delete all DutchLimit orders from the database.
  private static readonly ORDER_TYPE_JOI = Joi.string().valid(
    OrderType.Dutch,
    DUTCH_LIMIT,
    OrderType.Dutch_V2,
    OrderType.Dutch_V3,
    OrderType.Limit,
    OrderType.Relay,
    OrderType.Priority
  )

  private static readonly GET_ORDER_TYPE_JOI = Joi.string().valid(
    OrderType.Dutch,
    OrderType.Dutch_V2,
    OrderType.Dutch_V3,
    OrderType.Limit,
    OrderType.Relay,
    'Dutch_V1_V2',
    OrderType.Priority
  )

  private static readonly ETH_ADDRESS_JOI = Joi.string().custom((value: string, helpers: CustomHelpers<any>) => {
    if (!ethers.utils.isAddress(value)) {
      return helpers.message({ custom: 'VALIDATION ERROR: Invalid address' })
    }
    return value
  })

  public static isValidOrderStatus(): StringSchema {
    return this.ORDER_STATUS_JOI
  }

  public static isValidEthAddress(): StringSchema {
    return this.ETH_ADDRESS_JOI
  }

  public static isValidEncodedOrder(): StringSchema {
    return this.ENCODED_ORDER_JOI
  }

  public static isValidSignature(): StringSchema {
    return this.SIGNATURE_JOI
  }

  public static isValidOrderHash(): StringSchema {
    return this.ORDER_HASH_JOI
  }

  public static isValidLimit(): NumberSchema {
    return this.NUMBER_JOI
  }

  public static isValidCreatedAt(): NumberSchema {
    return this.NUMBER_JOI
  }

  public static isValidSortKey(): StringSchema {
    return this.SORT_KEY_JOI
  }

  public static isValidSort(): StringSchema {
    return this.SORT_JOI
  }

  public static isValidCursor(): StringSchema {
    return this.BASE_64_STRING
  }

  public static isValidChainId(): NumberSchema {
    return this.CHAIN_ID_JOI
  }

  public static isValidNonce(): StringSchema {
    return this.BIG_NUMBER_JOI
  }

  public static isValidQuoteId(): StringSchema {
    return this.UUIDV4_JOI
  }

  public static isValidRequestId(): StringSchema {
    return this.UUIDV4_JOI
  }

  public static isValidTxHash(): StringSchema {
    return this.TX_HASH_JOI
  }

  public static isValidOrderType(): StringSchema {
    return this.ORDER_TYPE_JOI
  }

  public static isValidGetQueryParamOrderType(): StringSchema {
    return this.GET_ORDER_TYPE_JOI
  }

  public static isValidAmount(): StringSchema {
    return this.BIG_NUMBER_JOI
  }

  public static isValidNumber(): NumberSchema {
    return this.NUMBER_JOI
  }

  public static isValidBigIntString(): StringSchema {
    return this.BIG_INT_STRING_JOI
  }

  public static isValidOrderHashes(): StringSchema {
    return this.ORDER_HASHES_JOI
  }

  public static isValidCosigner(): StringSchema {
    const cosigner = getEnvVar('LABS_COSIGNER')
    return Joi.string().valid(cosigner)
  }

  public static isValidPriorityCosigner(): StringSchema {
    const priorityCosigner = getEnvVar('LABS_PRIORITY_COSIGNER')
    return Joi.string().valid(priorityCosigner)
  }

  private static getHexiDecimalRegex(length?: number, maxLength = false): RegExp {
    let lengthModifier = '*'
    if (length) {
      lengthModifier = maxLength ? `{0,${length}}` : `{${length}}`
    }
    return new RegExp(`^0x[0-9,a-z,A-Z]${lengthModifier}$`)
  }
}
