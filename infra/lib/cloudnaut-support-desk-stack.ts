import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Simple, inline configuration for this learning deployment. No multi-env
 * abstraction: everything the stack needs is right here. Secret VALUES are
 * never put here — only the ECR repo names, sizes, and region are.
 */
export interface CloudnautSupportDeskStackProps extends StackProps {
  /** AWS account + region (defaults come from bin/infra.ts). */
  readonly env: { account?: string; region?: string };
  /** ECR repository names for the api + backend images. */
  readonly apiEcrRepo: string;
  readonly backendEcrRepo: string;
  /** Image tag to run (e.g. "latest"). */
  readonly imageTag: string;
  /** PostgreSQL major version ("16") — mapped to an in-region version below. */
  readonly postgresMajorVersion: string;
  /** Logical database name + master username. */
  readonly databaseName: string;
  readonly databaseUsername: string;
}

/**
 * CloudnautSupportDeskStack — the ENTIRE Cloudnaut Support Desk backend
 * infrastructure in ONE stack, kept intentionally simple for learning.
 *
 * Architecture:
 *   Internet
 *     -> API Gateway HTTP API           (public entry point)
 *     -> HTTP proxy integration
 *     -> EC2 (public subnet, Docker: api :4000 -> backend :8001)
 *          -> RDS PostgreSQL  (private, SG from EC2 only)
 *          -> S3              (attachments, private)
 *          -> Secrets Manager (DB creds + AUTH_SECRET_KEY)
 *
 * Deliberate simplifications vs. a production setup (and why):
 *   - NO NAT Gateway: EC2 sits in a PUBLIC subnet with a public IP and reaches
 *     ECR / Secrets Manager / S3 / SES over the Internet Gateway. This removes
 *     the single biggest hourly cost. RDS stays fully private.
 *   - NO internal ALB + VPC Link: API Gateway uses a plain HTTP proxy
 *     integration straight to the EC2 public DNS on :4000. Fewer moving parts,
 *     no ALB hourly cost.
 *   - NO Multi-AZ, Auto Scaling, or separate monitoring stack.
 *
 * Still private / still secure:
 *   - RDS is in isolated subnets, not publicly accessible, encrypted, and only
 *     reachable from the EC2 security group.
 *   - The backend container port 8001 is never published to the host or the
 *     internet; only api :4000 is exposed, and only to the EC2 SG ingress rule.
 *   - Secret values live in Secrets Manager, fetched by the instance at boot.
 */
export class CloudnautSupportDeskStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudnautSupportDeskStackProps) {
    super(scope, id, props);

    const region = props.env.region ?? Stack.of(this).region;
    const account = props.env.account ?? Stack.of(this).account;
    const cognitoUserPoolId = this.node.tryGetContext('cognitoUserPoolId');
    const cognitoAppClientId = this.node.tryGetContext('cognitoAppClientId');
    if (
      typeof cognitoUserPoolId !== 'string' ||
      !new RegExp(`^${region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[A-Za-z0-9]+$`).test(cognitoUserPoolId)
    ) {
      throw new Error(
        'Set CDK context cognitoUserPoolId to the Cognito User Pool ID for this region.',
      );
    }
    if (
      typeof cognitoAppClientId !== 'string' ||
      !/^[A-Za-z0-9]+$/.test(cognitoAppClientId)
    ) {
      throw new Error(
        'Set CDK context cognitoAppClientId to the public Cognito SPA App Client ID.',
      );
    }

    // ---------------------------------------------------------------------
    // 1. Network: one small VPC. Public subnets for EC2 (no NAT) + isolated
    //    subnets for the database. maxAzs=2 so RDS has a valid subnet group.
    // ---------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2,
      natGateways: 0, // cost: avoid the ~$32/mo NAT gateway entirely
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Free S3 gateway endpoint so attachment traffic doesn't need the IGW path.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ---------------------------------------------------------------------
    // 2. Security groups.
    //    - EC2 SG: inbound 4000 from within the VPC (API Gateway reaches the
    //      instance via its public DNS; we scope ingress to the VPC CIDR and
    //      document that API Gateway source-IP scoping needs a VPC Link, which
    //      we intentionally skipped). Egress open (ECR/Secrets/S3/SES).
    //    - DB SG: inbound 5432 ONLY from the EC2 SG.
    // ---------------------------------------------------------------------
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'EC2 host running the api (4000) + backend (8001) containers',
      allowAllOutbound: true,
    });
    // Public API port 4000. API Gateway HTTP proxy connects over the internet,
    // so we cannot scope to a source SG here. We allow 4000 from anywhere but
    // keep the backend (8001) unexposed. For tighter control, add a VPC Link +
    // internal ALB later. (Documented trade-off for a learning deploy.)
    appSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(4000),
      'Public API 4000 (via API Gateway HTTP proxy)',
    );
    // Backend 8001 is intentionally NOT opened — the api container reaches it
    // over the local Docker network only.

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'RDS PostgreSQL - 5432 from the EC2 app SG only',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(5432), 'PostgreSQL 5432 from EC2 SG only');

    // ---------------------------------------------------------------------
    // 3. S3 attachments bucket — private, encrypted, SSL-enforced.
    // ---------------------------------------------------------------------
    const attachmentsBucket = new s3.Bucket(this, 'AttachmentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // learning stack: destroy with the stack
      autoDeleteObjects: true,
    });

    // ---------------------------------------------------------------------
    // 4. Secrets.
    //    - DB credentials: generated by RDS into Secrets Manager.
    //    - App secret: generated AUTH_SECRET_KEY + empty SES SMTP placeholders.
    // ---------------------------------------------------------------------
    const appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      description: 'Cloudnaut app secrets: AUTH_SECRET_KEY + SES SMTP creds',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ SMTP_USERNAME: '', SMTP_PASSWORD: '' }),
        generateStringKey: 'AUTH_SECRET_KEY',
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    // ---------------------------------------------------------------------
    // 5. RDS PostgreSQL — standard DB instance (NOT Aurora: the Org SCP blocks
    //    rds:CreateDBCluster). Single-AZ, private, encrypted, gp2, 20 GB.
    // ---------------------------------------------------------------------
    // Create the DB credentials secret EXPLICITLY so every reference (IAM
    // grant, user-data, CloudFormation output) points at the real
    // AWS::SecretsManager::Secret ARN — not the SecretTargetAttachment that
    // `db.secret` would otherwise render.
    const dbSecret = new rds.DatabaseSecret(this, 'PostgresSecret', {
      username: props.databaseUsername,
    });

    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: this.resolvePostgresVersion(props.postgresMajorVersion),
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: props.databaseName,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ), // db.t4g.micro
      storageType: rds.StorageType.GP2,
      allocatedStorage: 20,
      multiAz: false,
      port: 5432,
      storageEncrypted: true,
      publiclyAccessible: false,
      backupRetention: Duration.days(1),
      removalPolicy: RemovalPolicy.DESTROY, // learning stack
    });
    // Note: passing `Credentials.fromSecret(dbSecret)` makes CDK attach the
    // secret to the instance automatically (adding host/port/dbname/engine to
    // the secret JSON). We deliberately keep a reference to `dbSecret` (the
    // real AWS::SecretsManager::Secret) and never read `db.secret`, so the IAM
    // grant, user-data, and output all use the underlying secret ARN.

    // ---------------------------------------------------------------------
    // 6. EC2 instance role (least privilege) + resolved ECR image URIs.
    // ---------------------------------------------------------------------
    const apiImage = `${account}.dkr.ecr.${region}.amazonaws.com/${props.apiEcrRepo}:${props.imageTag}`;
    const backendImage = `${account}.dkr.ecr.${region}.amazonaws.com/${props.backendEcrRepo}:${props.imageTag}`;

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Runtime role for the Cloudnaut Support Desk EC2 host',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    attachmentsBucket.grantReadWrite(role);
    appSecret.grantRead(role);
    dbSecret.grantRead(role);
    // ECR pull: GetAuthorizationToken is account-wide (cannot be scoped);
    // layer/image pulls scoped to the two app repositories.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [
          `arn:aws:ecr:${region}:${account}:repository/${props.apiEcrRepo}`,
          `arn:aws:ecr:${region}:${account}:repository/${props.backendEcrRepo}`,
        ],
      }),
    );
    // SES send (email is optional/deferred; empty from-address means unused).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );

    // ---------------------------------------------------------------------
    // 7. EC2 user-data: install Docker + compose, fetch secrets at boot,
    //    build DATABASE_URL, write a 0600 env file + a 2-service compose, and
    //    run via a reboot-safe systemd unit. Secrets never appear in source.
    // ---------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker awscli jq || yum install -y docker awscli jq',
      'systemctl enable --now docker',
      'usermod -aG docker ec2-user || true',
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'ARCH=$(uname -m); case "$ARCH" in x86_64) CARCH=x86_64;; aarch64) CARCH=aarch64;; *) CARCH=x86_64;; esac',
      'curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${CARCH}" -o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      'install -d -m 0750 /opt/cloudnaut',

      `AWS_REGION='${region}'`,
      `APP_SECRET_ARN='${appSecret.secretArn}'`,
      `DB_SECRET_ARN='${dbSecret.secretArn}'`,
      'APP_SECRET_JSON=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_SECRET_ARN" --query SecretString --output text)',
      'DB_SECRET_JSON=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text)',
      'AUTH_SECRET_KEY=$(printf "%s" "$APP_SECRET_JSON" | jq -r ".AUTH_SECRET_KEY // empty")',
      'SMTP_USERNAME=$(printf "%s" "$APP_SECRET_JSON" | jq -r ".SMTP_USERNAME // empty")',
      'SMTP_PASSWORD=$(printf "%s" "$APP_SECRET_JSON" | jq -r ".SMTP_PASSWORD // empty")',
      // Read the RDS-managed fields. After the SecretTargetAttachment runs,
      // the secret JSON contains username/password/host/port/dbname. We extract
      // with `// empty` so a MISSING key yields "" (not the literal string
      // "null" that bare `jq -r` would print) and then assert every required
      // field is present. This guarantees we NEVER compose a URL like
      // "...@host:null/db"; if a field is missing the boot fails loudly instead.
      'DB_USER=$(printf "%s" "$DB_SECRET_JSON" | jq -r ".username // empty")',
      'DB_PASS=$(printf "%s" "$DB_SECRET_JSON" | jq -r ".password // empty")',
      'DB_HOST=$(printf "%s" "$DB_SECRET_JSON" | jq -r ".host // empty")',
      'DB_PORT=$(printf "%s" "$DB_SECRET_JSON" | jq -r ".port // empty")',
      `DB_NAME=$(printf "%s" "$DB_SECRET_JSON" | jq -r ".dbname // \\"${props.databaseName}\\"")`,
      // Fail the boot (set -e) if any required DB field is absent/empty, so a
      // bad env file is never written and the container never crash-loops on a
      // malformed DATABASE_URL. Port must be numeric (defends against "null").
      '[ -n "$DB_USER" ] || { echo "FATAL: DB username missing from secret" >&2; exit 1; }',
      '[ -n "$DB_PASS" ] || { echo "FATAL: DB password missing from secret" >&2; exit 1; }',
      '[ -n "$DB_HOST" ] || { echo "FATAL: DB host missing from secret (secret not yet populated?)" >&2; exit 1; }',
      '[ -n "$DB_NAME" ] || { echo "FATAL: DB name missing from secret" >&2; exit 1; }',
      'case "$DB_PORT" in ""|*[!0-9]*) echo "FATAL: DB port is not numeric: [$DB_PORT] (secret not yet populated?)" >&2; exit 1;; esac',
      'DATABASE_URL="postgresql+psycopg2://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME"',

      'umask 077',
      'cat >/opt/cloudnaut/app.env <<EOF',
      'AWS_REGION=${AWS_REGION}',
      'AUTH_MODE=cognito',
      `COGNITO_USER_POOL_ID=${cognitoUserPoolId}`,
      `COGNITO_APP_CLIENT_ID=${cognitoAppClientId}`,
      `S3_BUCKET=${attachmentsBucket.bucketName}`,
      'DATABASE_URL=${DATABASE_URL}',
      'AUTH_SECRET_KEY=${AUTH_SECRET_KEY}',
      'BACKEND_URL=http://backend:8001',
      'PORT=4000',
      'SMTP_HOST=',
      'SMTP_PORT=587',
      'SMTP_USE_TLS=false',
      'SMTP_USERNAME=${SMTP_USERNAME}',
      'SMTP_PASSWORD=${SMTP_PASSWORD}',
      'SMTP_FROM_EMAIL=',
      'EOF',
      'chmod 600 /opt/cloudnaut/app.env',

      'cat >/opt/cloudnaut/docker-compose.prod.yml <<"EOF"',
      'services:',
      '  backend:',
      `    image: ${backendImage}`,
      '    container_name: app_backend',
      '    env_file: [/opt/cloudnaut/app.env]',
      '    expose: ["8001"]',
      '    networks: [app_network]',
      '    restart: unless-stopped',
      '  api:',
      `    image: ${apiImage}`,
      '    container_name: app_api',
      '    env_file: [/opt/cloudnaut/app.env]',
      '    environment: ["BACKEND_URL=http://backend:8001", "PORT=4000"]',
      '    ports: ["4000:4000"]',
      '    depends_on: [backend]',
      '    networks: [app_network]',
      '    restart: unless-stopped',
      'networks:',
      '  app_network:',
      '    driver: bridge',
      'EOF',

      `ECR_REGISTRY='${account}.dkr.ecr.${region}.amazonaws.com'`,
      'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY" || echo "ECR login failed; push images then: systemctl restart cloudnaut"',
      `docker pull ${backendImage} || echo "backend image not available yet"`,
      `docker pull ${apiImage} || echo "api image not available yet"`,

      'cat >/etc/systemd/system/cloudnaut.service <<"EOF"',
      '[Unit]',
      'Description=Cloudnaut Support Desk (docker compose)',
      'Requires=docker.service',
      'After=docker.service network-online.target',
      'Wants=network-online.target',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      'WorkingDirectory=/opt/cloudnaut',
      'ExecStart=/usr/bin/docker compose -f /opt/cloudnaut/docker-compose.prod.yml up -d',
      'ExecStop=/usr/bin/docker compose -f /opt/cloudnaut/docker-compose.prod.yml down',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      'systemctl daemon-reload',
      'systemctl enable cloudnaut.service',
      'systemctl start cloudnaut.service || echo "cloudnaut starts once images are available"',
    );

    const instance = new ec2.Instance(this, 'AppInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType('t8i.small'), // x86_64, matches the Docker images
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: appSg,
      role,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // CRITICAL ordering: the instance user-data reads host/port/dbname from the
    // DB secret, but those fields are written by the SecretTargetAttachment that
    // CDK creates for `Credentials.fromSecret(dbSecret)` — which only completes
    // once the RDS instance exists. Without this dependency CloudFormation may
    // launch the EC2 host (and run user-data) BEFORE the attachment populates
    // the secret, so `jq .port` returns "null" and DATABASE_URL becomes
    // "...@host:null/db" (ValueError: invalid literal for int() ... 'null').
    // Depending on the DatabaseInstance forces the attachment to finish first.
    instance.node.addDependency(db);

    // ---------------------------------------------------------------------
    // 8. API Gateway HTTP API -> HTTP proxy to the EC2 public DNS :4000.
    //    No VPC Link / no ALB. The $default route forwards every path.
    // ---------------------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'Public entry point for the Cloudnaut Support Desk API',
    });
    // Catch-all route: ANY /{proxy+} forwards every sub-path (e.g. /health,
    // /requests, /attachments/{id}) to EC2 on :4000 with the same path. The
    // {proxy} variable in the integration URI is supplied by the {proxy+}
    // greedy path parameter in the route key.
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpUrlIntegration(
        'Ec2ProxyIntegration',
        `http://${instance.instancePublicDnsName}:4000/{proxy}`,
        { method: apigwv2.HttpMethod.ANY },
      ),
    });
    // Root route: ANY / maps to the EC2 root (the {proxy+} route does not match
    // the empty path). No path variable in the URI, so no mismatch.
    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpUrlIntegration(
        'Ec2RootIntegration',
        `http://${instance.instancePublicDnsName}:4000/`,
        { method: apigwv2.HttpMethod.ANY },
      ),
    });

    // ---------------------------------------------------------------------
    // 8.5 Amazon Cognito (Phase 2 of the auth migration).
    //
    //   Cognito supplies verified identities; PostgreSQL remains authoritative
    //   for application access and roles. The backend only maps a verified
    //   identity into a member after an Admin approves its access request.
    //
    //   Sign-in is by EMAIL to match the application, where login looks users
    //   up by email (workspace/backend/app/main.py). The password policy
    //   mirrors the app's existing 12-character minimum for staff/admin
    //   accounts (bootstrap_admin.py / TeamManagement.jsx). Public sign-up is
    //   enabled for Employee/Support onboarding, but does not grant application
    //   access until a verified request is approved by an Admin.
    // ---------------------------------------------------------------------
    // SMS delivery has an SNS cost and, for Indian (+91) numbers, requires
    // TRAI/DLT sender registration. Phone-attribute verification can be enabled
    // independently from SMS MFA with -c enablePhoneSmsVerification=true.
    // SMS MFA remains opt-in separately with -c enableSmsMfa=true.
    const enableSmsMfa = this.node.tryGetContext('enableSmsMfa') === 'true';
    const enablePhoneSmsVerification =
      this.node.tryGetContext('enablePhoneSmsVerification') === 'true';
    const cognitoSmsRoleArn = this.node.tryGetContext('cognitoSmsRoleArn');
    const cognitoSmsRole =
      typeof cognitoSmsRoleArn === 'string'
        ? iam.Role.fromRoleArn(this, 'CognitoSmsRole', cognitoSmsRoleArn)
        : undefined;

    const userPool = new cognito.UserPool(this, 'UserPool', {
      // Email is the sign-in identifier (case-insensitive), matching the app.
      signInAliases: { email: true },
      signInCaseSensitive: false,
      // Public registration only creates a Cognito identity. Application access
      // remains gated by verified email and Admin approval in PostgreSQL.
      selfSignUpEnabled: true,
      // Always auto-verify email. Phone auto-verification is only valid when an
      // SMS configuration (SNS role) exists, so it is gated on enableSmsMfa —
      // otherwise Cognito rejects the pool ("SMS configuration is required when
      // phone_number is selected for auto verification"). With SMS off, a phone
      // number is still collected as a profile attribute and verified on demand
      // via the account UI's explicit verification flow.
      autoVerify: { email: true, phone: enableSmsMfa },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
        // Optional E.164 contact number. Mapped to team_members.phone_number.
        phoneNumber: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: cognito.Mfa.OPTIONAL,
      // TOTP (software token) is always available. SMS is added as a second
      // option ONLY when -c enableSmsMfa=true (see note above).
      mfaSecondFactor: { sms: enableSmsMfa, otp: true },
      // Cognito needs an SNS role for either SMS-based phone verification or
      // SMS MFA. Do not implicitly enable SMS MFA or phone auto-verification.
      smsRole: cognitoSmsRole,
      enableSmsRole: Boolean(cognitoSmsRole) || enableSmsMfa || enablePhoneSmsVerification,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // RETAIN: real user identities (and their immutable `sub`, mapped to
      // team_members.cognito_sub) must survive a stack destroy/replace. Unlike
      // the RDS/S3 DESTROY learning-stack resources, Cognito subs cannot be
      // regenerated to match existing records, so the pool is preserved.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Public SPA + API client. NO client secret: a browser-based React app
    // cannot keep one. Only the SRP and plain username/password flows are
    // enabled; admin and custom auth flows are intentionally left OFF.
    const userPoolClient = userPool.addClient('SpaClient', {
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
        adminUserPassword: false,
        custom: false,
      },
      // Do not reveal whether an email exists on failed sign-in.
      preventUserExistenceErrors: true,
      // SDK-based auth (SRP/USER_PASSWORD) only — NOT Hosted UI / OAuth. This
      // empty oAuth block suppresses CDK's DEFAULT OAuth values (otherwise
      // flows=[implicit,code], scopes, and a https://example.com callback). It
      // is paired with the escape hatch below that sets
      // AllowedOAuthFlowsUserPoolClient=false, so NO OAuth flows/scopes/
      // callbacks are emitted — resolving the invalid combination that broke
      // the deploy.
      oAuth: {
        flows: { authorizationCodeGrant: false, implicitCodeGrant: false, clientCredentials: false },
        callbackUrls: [],
        scopes: [],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // The L2 construct leaves `AllowedOAuthFlowsUserPoolClient` TRUE by default
    // even with no OAuth flows/scopes, which CloudFormation rejects
    // ("AllowedOAuthFlows and AllowedOAuthScopes are required if user pool
    // client is allowed to use OAuth flows"). This app uses direct SRP/
    // USER_PASSWORD auth (no Hosted UI), so disable OAuth on the client
    // outright via the L1 escape hatch.
    const cfnSpaClient = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
    cfnSpaClient.allowedOAuthFlowsUserPoolClient = false;

    // ---------------------------------------------------------------------
    // 8.6 Dedicated migration role (Phase b2) — least privilege, Option B.
    //
    //   A SEPARATE role (not the always-on EC2 app role) assumed only when the
    //   one-time bulk migration tool runs. It grants ONLY the three admin
    //   actions that tool uses, scoped to THIS User Pool's ARN:
    //     - cognito-idp:AdminCreateUser     (create + invitation email)
    //     - cognito-idp:AdminGetUser        (idempotent re-link of an existing user)
    //     - cognito-idp:ListUsers           (lookup/verification)
    //   It deliberately does NOT include AdminSetUserPassword (invitation flow
    //   owns passwords), AdminDeleteUser, or any wildcard. Assumable by the
    //   account root so an operator (or the EC2 host via SSM) can assume it;
    //   tighten the principal to a specific operator/role ARN as needed.
    // ---------------------------------------------------------------------
    const migrationRole = new iam.Role(this, 'CognitoMigrationRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description:
        'One-time Cognito bulk-migration role (least privilege, scoped to the User Pool)',
    });
    migrationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoBulkMigrationAdmin',
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:ListUsers',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    // ---------------------------------------------------------------------
    // 9. Outputs (no secret values).
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Public API Gateway invoke URL (set as the frontend VITE_API_URL)',
    });
    new CfnOutput(this, 'InstancePublicDns', {
      value: instance.instancePublicDnsName,
      description: 'EC2 public DNS (API Gateway proxies here on :4000)',
    });
    new CfnOutput(this, 'AttachmentsBucketName', {
      value: attachmentsBucket.bucketName,
      description: 'S3 bucket for ticket attachments',
    });
    new CfnOutput(this, 'DbEndpoint', {
      value: db.dbInstanceEndpointAddress,
      description: 'RDS PostgreSQL endpoint (private)',
    });
    new CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN for the RDS credentials',
    });
    new CfnOutput(this, 'AppSecretArn', {
      value: appSecret.secretArn,
      description: 'Secrets Manager ARN for AUTH_SECRET_KEY + SES SMTP creds',
    });
    // Cognito identifiers are NOT secrets — the public SPA client needs both.
    new CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'Amazon Cognito User Pool ID',
    });
    new CfnOutput(this, 'CognitoAppClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Amazon Cognito App Client ID (public SPA client, no secret)',
    });
    new CfnOutput(this, 'CognitoMigrationRoleArn', {
      value: migrationRole.roleArn,
      description: 'IAM role ARN to assume when running the one-time Cognito migration tool',
    });
  }

  /** Map a PostgreSQL major version to an in-region CDK enum member. */
  private resolvePostgresVersion(major: string): rds.PostgresEngineVersion {
    switch (major) {
      case '15':
        return rds.PostgresEngineVersion.VER_15_4;
      case '16':
        // 16.13 is available in ap-south-1 and present in the installed CDK.
        return rds.PostgresEngineVersion.VER_16_13;
      default:
        throw new Error(
          `Unsupported PostgreSQL major version "${major}". Use "15" or "16".`,
        );
    }
  }
}
