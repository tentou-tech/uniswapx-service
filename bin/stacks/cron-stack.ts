import * as cdk from 'aws-cdk-lib'
import * as aws_events from 'aws-cdk-lib/aws-events'
import * as aws_iam from 'aws-cdk-lib/aws-iam'
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs'
import path from 'path'

import { SERVICE_NAME, UNIMIND_ALGORITHM_CRON_INTERVAL } from '../constants'

export interface CronStackProps extends cdk.NestedStackProps {
  lambdaRole: aws_iam.Role
  chatbotSNSArn?: string
  envVars?: { [key: string]: string }
}

export class CronStack extends cdk.NestedStack {
  public readonly unimindAlgorithmCronLambda?: aws_lambda_nodejs.NodejsFunction

  constructor(scope: Construct, name: string, props: CronStackProps) {
    super(scope, name, props)
    const { lambdaRole } = props

    this.unimindAlgorithmCronLambda = new aws_lambda_nodejs.NodejsFunction(this, 'unimindAlgorithmCronLambda', {
      role: lambdaRole,
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      entry: path.join(__dirname, '../../lib/crons/unimind-algorithm.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
    })

    new aws_events.Rule(this, `${SERVICE_NAME}UnimindAlgorithmCron`, {
      schedule: aws_events.Schedule.rate(cdk.Duration.minutes(UNIMIND_ALGORITHM_CRON_INTERVAL)),
      targets: [new cdk.aws_events_targets.LambdaFunction(this.unimindAlgorithmCronLambda)],
    })
  }
}
