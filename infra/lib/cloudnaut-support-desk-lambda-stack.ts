import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { GitHubOidcDeployRole } from './github-oidc';

export interface CloudnautSupportDeskLambdaStackProps extends StackProps {
  readonly lambdaEcrRepo: string;
  readonly imageTag: string;
  readonly postgresMajorVersion: string;
  readonly databaseName: string;
  readonly databaseUsername: string;
}

/** Production backend: API Gateway -> Lambda -> RDS Proxy/RDS. No EC2. */
export class CloudnautSupportDeskLambdaStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudnautSupportDeskLambdaStackProps) {
    super(scope, id, props);

    const region = props.env?.region ?? Stack.of(this).region;
    const account = props.env?.account ?? Stack.of(this).account;
    const userPoolId = this.node.tryGetContext('cognitoUserPoolId');
    const appClientId = this.node.tryGetContext('cognitoAppClientId');
    if (typeof userPoolId !== 'string' || typeof appClientId !== 'string') {
      throw new Error('Set cognitoUserPoolId and cognitoAppClientId CDK context values.');
    }

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.50.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const attachmentsBucket = new s3.Bucket(this, 'AttachmentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      description: 'Cloudnaut Lambda application secrets',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          SES_FROM_EMAIL: '',
          SMTP_USERNAME: '',
          SMTP_PASSWORD: '',
        }),
        generateStringKey: 'AUTH_SECRET_KEY',
        excludePunctuation: true,
        passwordLength: 48,
      },
    });
    const dbSecret = new rds.DatabaseSecret(this, 'PostgresSecret', {
      username: props.databaseUsername,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'RDS PostgreSQL reachable only through RDS Proxy',
      allowAllOutbound: false,
    });
    const proxySg = new ec2.SecurityGroup(this, 'ProxySg', {
      vpc,
      description: 'RDS Proxy security group',
      allowAllOutbound: true,
    });
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Lambda runtime security group',
      allowAllOutbound: true,
    });
    proxySg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Lambda to RDS Proxy');
    dbSg.addIngressRule(proxySg, ec2.Port.tcp(5432), 'RDS Proxy to PostgreSQL');

    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: this.resolvePostgresVersion(props.postgresMajorVersion),
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: props.databaseName,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      storageType: rds.StorageType.GP2,
      allocatedStorage: 20,
      multiAz: false,
      port: 5432,
      storageEncrypted: true,
      publiclyAccessible: false,
      backupRetention: Duration.days(7),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const proxy = new rds.DatabaseProxy(this, 'RdsProxy', {
      proxyTarget: rds.ProxyTarget.fromInstance(db),
      secrets: [dbSecret],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [proxySg],
      requireTLS: true,
      idleClientTimeout: Duration.minutes(30),
    });

    const runtimeRole = new iam.Role(this, 'LambdaRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    });
    attachmentsBucket.grantReadWrite(runtimeRole);
    appSecret.grantRead(runtimeRole);
    dbSecret.grantRead(runtimeRole);
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:GetUser'],
      resources: ['*'],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const repository = ecr.Repository.fromRepositoryName(this, 'LambdaRepository', props.lambdaEcrRepo);
    const apiFunction = new lambda.DockerImageFunction(this, 'ApiFunction', {
      code: lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: props.imageTag }),
      role: runtimeRole,
      memorySize: 1024,
      timeout: Duration.seconds(28),
      ephemeralStorageSize: Size.mebibytes(1024),
      vpc,
      securityGroups: [lambdaSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        AUTH_MODE: 'cognito',
        COGNITO_USER_POOL_ID: userPoolId,
        COGNITO_APP_CLIENT_ID: appClientId,
        S3_BUCKET: attachmentsBucket.bucketName,
        APP_SECRET_ARN: appSecret.secretArn,
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_PROXY_ENDPOINT: proxy.endpoint,
        DB_NAME: props.databaseName,
        DB_SSLMODE: 'require',
        DB_POOL_SIZE: '1',
        DB_MAX_OVERFLOW: '0',
        BACKEND_URL: '',
        FRONTEND_ORIGINS: '',
      },
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'Cloudnaut Support Desk Lambda API',
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('LambdaIntegration', apiFunction),
    });
    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('LambdaRootIntegration', apiFunction),
    });

    const userPool = cognito.UserPool.fromUserPoolId(this, 'ExistingUserPool', userPoolId);
    const client = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      'ExistingSpaClient',
      appClientId,
    );

    const githubDeploy = new GitHubOidcDeployRole(this, 'GitHubOidcDeploy', {
      repo: this.node.tryGetContext('githubRepo') ?? 'ramkrushnazende/ramkrushnazende-cloudnaut-support-desk',
      branch: 'main',
      account,
      region,
      ecrRepos: [props.lambdaEcrRepo],
      lambdaFunctionName: apiFunction.functionName,
      createOidcProvider: this.node.tryGetContext('createGithubOidcProvider') !== 'false',
    });

    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'LambdaFunctionName', { value: apiFunction.functionName });
    new CfnOutput(this, 'AttachmentsBucketName', { value: attachmentsBucket.bucketName });
    new CfnOutput(this, 'DbProxyEndpoint', { value: proxy.endpoint });
    new CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn });
    new CfnOutput(this, 'AppSecretArn', { value: appSecret.secretArn });
    new CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'CognitoAppClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'GitHubActionsDeployRoleArn', { value: githubDeploy.role.roleArn });
  }

  private resolvePostgresVersion(major: string): rds.PostgresEngineVersion {
    switch (major) {
      case '15': return rds.PostgresEngineVersion.VER_15_4;
      case '16': return rds.PostgresEngineVersion.VER_16_13;
      default: throw new Error(`Unsupported PostgreSQL major version "${major}".`);
    }
  }
}
