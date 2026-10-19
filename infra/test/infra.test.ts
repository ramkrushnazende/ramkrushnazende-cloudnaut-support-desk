import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CloudnautSupportDeskStack } from '../lib/cloudnaut-support-desk-stack';
import { FrontendStack } from '../lib/frontend-stack';

function synthFrontend() {
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'CloudnautSupportDeskFrontendStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    // Point at the infra project's own dir as a stand-in asset so the test
    // never depends on the frontend being built; the stack logic (bucket,
    // CloudFront, OAC, SPA responses) is what we assert.
    frontendDistPath: path.resolve(__dirname, '..'),
  });
  return Template.fromStack(stack);
}

function synth(extraContext: Record<string, string> = {}) {
  const app = new cdk.App({
    context: {
      cognitoUserPoolId: 'ap-south-1_ywRrGmxpM',
      cognitoAppClientId: '36hud2677sjbeb1qjov197fmai',
      ...extraContext,
    },
  });
  const stack = new CloudnautSupportDeskStack(app, 'CloudnautSupportDeskStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    apiEcrRepo: 'cloudnaut-support-desk-api',
    backendEcrRepo: 'cloudnaut-support-desk-backend',
    imageTag: 'latest',
    postgresMajorVersion: '16',
    databaseName: 'cloudnaut_db',
    databaseUsername: 'cloudnaut',
  });
  return Template.fromStack(stack);
}

test('everything is in a single stack (one of each core resource)', () => {
  const t = synth();
  t.resourceCountIs('AWS::EC2::Instance', 1);
  t.resourceCountIs('AWS::RDS::DBInstance', 1);
  t.resourceCountIs('AWS::S3::Bucket', 1);
  t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
});

test('no NAT Gateway, no ALB, no VPC Link (simplified architecture)', () => {
  const t = synth();
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  t.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 0);
});

test('database is standard RDS PostgreSQL, not Aurora', () => {
  const t = synth();
  t.resourceCountIs('AWS::RDS::DBCluster', 0);
  t.hasResourceProperties('AWS::RDS::DBInstance', {
    Engine: 'postgres',
    DBInstanceClass: 'db.t4g.micro',
    AllocatedStorage: '20',
    MultiAZ: false,
    StorageEncrypted: true,
    StorageType: 'gp2',
    Port: '5432',
    PubliclyAccessible: false,
  });
});

test('RDS credentials come from Secrets Manager (no inline password)', () => {
  const t = synth();
  const instances = t.findResources('AWS::RDS::DBInstance');
  for (const res of Object.values(instances)) {
    const p = (res as any).Properties;
    expect(JSON.stringify(p.MasterUserPassword)).toContain('resolve:secretsmanager');
    expect(p.MasterUsername).toBeDefined();
  }
});

test('S3 attachments bucket blocks public access and enforces SSL', () => {
  const t = synth();
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: Match.anyValue(),
    }),
  });
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: Match.objectLike({ Bool: { 'aws:SecureTransport': 'false' } }),
        }),
      ]),
    }),
  });
});

test('DB security group allows 5432 only from the EC2 SG (not a CIDR)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 5432,
    ToPort: 5432,
    SourceSecurityGroupId: Match.anyValue(),
  });
  // No ingress rule opens 5432 to a CIDR / the world.
  const ingress = t.findResources('AWS::EC2::SecurityGroupIngress');
  for (const res of Object.values(ingress)) {
    const p = (res as any).Properties;
    if (p.FromPort === 5432) {
      expect(p.CidrIp).toBeUndefined();
    }
  }
});

test('backend port 8001 is never opened in any security group', () => {
  const t = synth();
  const groups = t.findResources('AWS::EC2::SecurityGroup');
  const ingressRules = t.findResources('AWS::EC2::SecurityGroupIngress');
  const check = (p: any) => expect(p?.FromPort).not.toBe(8001);
  for (const g of Object.values(groups)) {
    for (const rule of ((g as any).Properties.SecurityGroupIngress ?? [])) check(rule);
  }
  for (const r of Object.values(ingressRules)) check((r as any).Properties);
});

test('EC2 role has scoped S3 + Secrets + ECR pull, no admin/wildcards', () => {
  const t = synth();
  const policies = t.findResources('AWS::IAM::Policy');
  const actions: string[] = [];
  for (const res of Object.values(policies)) {
    for (const s of (res as any).Properties.PolicyDocument.Statement) {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      actions.push(...a);
    }
  }
  expect(actions).toEqual(
    expect.arrayContaining([
      's3:GetObject*',
      's3:PutObject',
      'ecr:GetAuthorizationToken',
      'ecr:BatchGetImage',
    ]),
  );
  expect(actions.some((a) => a?.startsWith('secretsmanager:GetSecretValue'))).toBe(true);
  expect(actions).not.toContain('s3:*');
  expect(actions).not.toContain('ecr:*');
  expect(actions).not.toContain('*');
});

test('EC2 runtime role has no Cognito admin provisioning permissions', () => {
  const t = synth();
  const policies = t.findResources('AWS::IAM::Policy');
  const runtimeRoleCognitoStatements: any[] = [];

  for (const policy of Object.values(policies) as any[]) {
    const roleRefs = policy.Properties.Roles.map((role: any) => role.Ref);
    if (!roleRefs.includes('InstanceRole3CCE2F1D')) continue;

    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (
        Array.isArray(statement.Action) &&
        statement.Action.some((action: string) => action.startsWith('cognito-idp:'))
      ) {
        runtimeRoleCognitoStatements.push(statement);
      }
    }
  }

  expect(runtimeRoleCognitoStatements).toHaveLength(0);
});

test('API Gateway HTTP API exposes a public invoke URL output', () => {
  const t = synth();
  t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
  const outputs = t.findOutputs('ApiUrl');
  expect(Object.keys(outputs).length).toBe(1);
});

test('EC2 app environment configures Cognito for both application containers', () => {
  const t = synth();
  const template = JSON.stringify(t.toJSON());
  expect(template).toContain('AWS_REGION=${AWS_REGION}');
  expect(template).toContain('AUTH_MODE=cognito');
  expect(template).toContain('COGNITO_USER_POOL_ID=ap-south-1_ywRrGmxpM');
  expect(template).toContain('COGNITO_APP_CLIENT_ID=36hud2677sjbeb1qjov197fmai');
  expect(template.match(/env_file: \[\/opt\/cloudnaut\/app.env\]/g)).toHaveLength(2);
});


// ---------------------------------------------------------------------------
// Cognito (Phase 2) — exactly one User Pool + one public SPA client, secure
// policy, email sign-in, no client secret, and non-secret outputs.
// ---------------------------------------------------------------------------

test('exactly one Cognito User Pool and one App Client are created', () => {
  const t = synth();
  t.resourceCountIs('AWS::Cognito::UserPool', 1);
  t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
});

test('User Pool is RETAINED on stack deletion (identities must survive destroy)', () => {
  const t = synth();
  // RemovalPolicy.RETAIN renders as Retain on both the deletion and
  // update-replace policies at the resource level (not under Properties).
  t.hasResource('AWS::Cognito::UserPool', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('User Pool signs in by email, auto-verifies email, and permits public sign-up', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    UsernameAttributes: ['email'],
    // email is auto-verified (phone_number is also auto-verified now; see the
    // dedicated phone-attribute test). arrayWith avoids coupling to list length.
    AutoVerifiedAttributes: Match.arrayWith(['email']),
    AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: false }),
    UsernameConfiguration: { CaseSensitive: false },
  });
});

test('User Pool enforces a strong password policy (12+, all character classes)', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    Policies: {
      PasswordPolicy: Match.objectLike({
        MinimumLength: 12,
        RequireLowercase: true,
        RequireUppercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
      }),
    },
  });
});

test('User Pool offers TOTP MFA and keeps SMS MFA OFF by default', () => {
  const t = synth();
  // Optional MFA with the software token (TOTP) enabled; SMS not in the list.
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    MfaConfiguration: 'OPTIONAL',
    EnabledMfas: Match.arrayWith(['SOFTWARE_TOKEN_MFA']),
  });
  const pools = t.findResources('AWS::Cognito::UserPool');
  const pool = Object.values(pools)[0] as any;
  const mfas: string[] = pool.Properties.EnabledMfas ?? [];
  expect(mfas).not.toContain('SMS_MFA');
});

test('User Pool collects an optional phone_number attribute; phone auto-verify is off by default', () => {
  const t = synth();
  // The attribute is always present (collected), and email is auto-verified.
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    AutoVerifiedAttributes: Match.arrayWith(['email']),
    Schema: Match.arrayWith([
      Match.objectLike({ Name: 'phone_number', Required: false, Mutable: true }),
    ]),
  });
  // With SMS disabled (default), phone_number must NOT be auto-verified — else
  // Cognito rejects the pool ("SMS configuration is required ...").
  const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0] as any;
  const autoVerified: string[] = pool.Properties.AutoVerifiedAttributes ?? [];
  expect(autoVerified).not.toContain('phone_number');
});

test('phone SMS verification configures delivery without enabling SMS MFA or signup auto-verification', () => {
  const t = synth({ enablePhoneSmsVerification: 'true' });
  const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0] as any;

  expect(pool.Properties.SmsConfiguration).toBeDefined();
  expect(pool.Properties.AutoVerifiedAttributes).not.toContain('phone_number');
  expect(pool.Properties.EnabledMfas ?? []).not.toContain('SMS_MFA');
});

test('phone SMS verification can use an existing narrowly managed Cognito delivery role', () => {
  const roleArn = 'arn:aws:iam::123456789012:role/CloudnautSupportDeskCognitoSmsDeliveryRole';
  const t = synth({
    enablePhoneSmsVerification: 'true',
    cognitoSmsRoleArn: roleArn,
  });
  const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0] as any;

  expect(pool.Properties.SmsConfiguration.SnsCallerArn).toBe(roleArn);
  expect(Object.keys(t.findResources('AWS::IAM::Role'))).not.toContain('UserPoolsmsRole4EA729DD');
});

test('App client is public (no secret) and uses only SRP + user-password flows', () => {
  const t = synth();
  const clients = t.findResources('AWS::Cognito::UserPoolClient');
  const client = Object.values(clients)[0] as any;
  // A public client never generates a secret.
  expect(client.Properties.GenerateSecret).toBeFalsy();
  const flows: string[] = client.Properties.ExplicitAuthFlows ?? [];
  expect(flows).toEqual(
    expect.arrayContaining(['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
  );
  // Admin-password and custom auth flows must NOT be enabled.
  expect(flows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
  expect(flows).not.toContain('ALLOW_CUSTOM_AUTH');
  // Do not leak whether an account exists.
  expect(client.Properties.PreventUserExistenceErrors).toBe('ENABLED');
  // SDK-based auth only: OAuth / Hosted UI is DISABLED on the client. This is
  // the regression guard for the deploy failure "AllowedOAuthFlows and
  // AllowedOAuthScopes are required if user pool client is allowed to use OAuth
  // flows": the flag must be false (not true-with-empty-flows), and no OAuth
  // flows or callback URLs may be present.
  expect(client.Properties.AllowedOAuthFlowsUserPoolClient).toBe(false);
  expect(client.Properties.AllowedOAuthFlows ?? []).toHaveLength(0);
  expect(client.Properties.CallbackURLs ?? []).toHaveLength(0);
});

test('Cognito IDs are exported as outputs and no Cognito secret is output', () => {
  const t = synth();
  expect(Object.keys(t.findOutputs('CognitoUserPoolId')).length).toBe(1);
  expect(Object.keys(t.findOutputs('CognitoAppClientId')).length).toBe(1);
  // Guard: no output should expose a client secret value.
  const allOutputs = t.toJSON().Outputs ?? {};
  for (const key of Object.keys(allOutputs)) {
    expect(key.toLowerCase()).not.toContain('clientsecret');
  }
});


// ---------------------------------------------------------------------------
// GitHub Actions OIDC deploy role (CI/CD)
// ---------------------------------------------------------------------------

test('creates a GitHub OIDC provider and a scoped deploy role', () => {
  const t = synth();
  t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  // Trust policy restricts to the sts audience and the repo+main branch.
  t.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'github-actions-cloudnaut-deploy',
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: Match.objectLike({
            StringEquals: Match.objectLike({
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            }),
            StringLike: Match.objectLike({
              'token.actions.githubusercontent.com:sub':
                'repo:ramkrushnazende/ramkrushnazende-cloudnaut-support-desk:ref:refs/heads/main',
            }),
          }),
        }),
      ]),
    }),
  });
});

test('deploy role has no wildcard admin and exposes its ARN as an output', () => {
  const t = synth();
  // The deploy role must not grant blanket admin.
  const policies = t.findResources('AWS::IAM::Policy');
  const actions: string[] = [];
  for (const res of Object.values(policies)) {
    for (const s of (res as any).Properties.PolicyDocument.Statement) {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      actions.push(...a);
    }
  }
  expect(actions).not.toContain('*');
  expect(actions).toEqual(expect.arrayContaining(['ecr:PutImage', 'ssm:SendCommand']));
  expect(Object.keys(t.findOutputs('GitHubActionsDeployRoleArn')).length).toBe(1);
});


// ---------------------------------------------------------------------------
// Frontend stack (separate from the backend stack)
// ---------------------------------------------------------------------------

test('frontend S3 bucket is private (blocks all public access)', () => {
  const t = synthFrontend();
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('frontend uses CloudFront with Origin Access Control (OAC), not legacy OAI', () => {
  const t = synthFrontend();
  t.resourceCountIs('AWS::CloudFront::Distribution', 1);
  // OAC resource is created (modern access control).
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: Match.objectLike({
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
    }),
  });
  // No legacy Origin Access Identity.
  t.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
});

test('frontend bucket policy grants read only to the CloudFront distribution', () => {
  const t = synthFrontend();
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
        }),
      ]),
    }),
  });
});

test('CloudFront redirects HTTP to HTTPS and serves index.html as root', () => {
  const t = synthFrontend();
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: 'redirect-to-https',
      }),
    }),
  });
});

test('CloudFront SPA fallback maps 403/404 to /index.html with 200', () => {
  const t = synthFrontend();
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({
          ErrorCode: 403,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
        }),
        Match.objectLike({
          ErrorCode: 404,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
        }),
      ]),
    }),
  });
});

test('frontend stack exposes a CloudFront URL output', () => {
  const t = synthFrontend();
  const outputs = t.findOutputs('FrontendUrl');
  expect(Object.keys(outputs).length).toBe(1);
});
