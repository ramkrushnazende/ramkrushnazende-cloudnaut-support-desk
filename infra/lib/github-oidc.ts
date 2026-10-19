import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GitHubOidcDeployRoleProps {
  /** "owner/repo" allowed to assume the role. */
  readonly repo: string;
  /** Branch allowed to assume the role for production deploys (e.g. "main"). */
  readonly branch: string;
  /** AWS account id (for ARN scoping). */
  readonly account: string;
  /** AWS region (for ARN scoping). */
  readonly region: string;
  /** ECR repository names the pipeline pushes to. */
  readonly ecrRepos: string[];
  /** EC2 instance id the pipeline deploys to via SSM. */
  readonly instanceId: string;
  /**
   * Whether to CREATE the GitHub OIDC provider. False when one already exists
   * in the account (there can be only one per issuer URL) — then it is looked
   * up instead.
   */
  readonly createOidcProvider: boolean;
}

/**
 * A least-privilege IAM role that GitHub Actions assumes via OIDC (no long-lived
 * keys). Trust is restricted to a single repo + branch and the
 * sts.amazonaws.com audience. Permissions cover exactly what the deploy
 * pipeline needs: CDK deploy (via the bootstrap roles), ECR push, SSM deploy to
 * the one instance, frontend S3 publish, and CloudFront invalidation.
 */
export class GitHubOidcDeployRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcDeployRoleProps) {
    super(scope, id);

    const providerArn = `arn:aws:iam::${props.account}:oidc-provider/token.actions.githubusercontent.com`;

    const provider = props.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOidcProvider', providerArn);

    // Trust: only this repo on this branch, only the sts audience.
    this.role = new iam.Role(this, 'Role', {
      roleName: 'github-actions-cloudnaut-deploy',
      description: 'Assumed by GitHub Actions via OIDC to deploy Cloudnaut Support Desk',
      assumedBy: new iam.OpenIdConnectPrincipal(provider as iam.IOpenIdConnectProvider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:ref:refs/heads/${props.branch}`,
        },
      }),
    });

    // --- CDK deploy: assume the CDK bootstrap roles (deploy/file-publish/
    //     image-publish/lookup). This is the standard, scoped way to let CI run
    //     `cdk deploy` without granting broad CloudFormation/* + resource/*. ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${props.account}:role/cdk-hnb659fds-*-${props.account}-${props.region}`],
      }),
    );

    // --- ECR: auth token is account-wide; push/pull scoped to the two repos. ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPushPull',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: props.ecrRepos.map(
          (r) => `arn:aws:ecr:${props.region}:${props.account}:repository/${r}`,
        ),
      }),
    );

    // --- SSM deploy: send a command to the ONE app instance + read its result. ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmSendCommandToInstance',
        actions: ['ssm:SendCommand'],
        resources: [
          `arn:aws:ec2:${props.region}:${props.account}:instance/${props.instanceId}`,
          // The AWS-RunShellScript document is an AWS-owned document.
          'arn:aws:ssm:*::document/AWS-RunShellScript',
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmReadCommandResults',
        actions: [
          'ssm:GetCommandInvocation',
          'ssm:ListCommandInvocations',
          'ssm:ListCommands',
          'ssm:DescribeInstanceInformation',
        ],
        // These read APIs do not support resource-level scoping for commands.
        resources: ['*'],
      }),
    );

    // --- CloudFormation: read outputs the pipeline consumes + run the
    //     change-set safety guard + let `cdk deploy` drive CloudFormation.
    //     Scoped to this project's stacks + the CDK bootstrap (CDKToolkit)
    //     stack that `cdk deploy` inspects. The actual resource mutations are
    //     performed by the assumed cdk-* bootstrap roles (cfn-exec), not by
    //     this role directly. ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFormationDeploy',
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:CreateChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:GetTemplateSummary',
        ],
        resources: [
          `arn:aws:cloudformation:${props.region}:${props.account}:stack/CloudnautSupportDesk*/*`,
          `arn:aws:cloudformation:${props.region}:${props.account}:stack/CDKToolkit/*`,
        ],
      }),
    );
    // CDK reads the bootstrap version from SSM before deploying.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CdkBootstrapVersionLookup',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [`arn:aws:ssm:${props.region}:${props.account}:parameter/cdk-bootstrap/*`],
      }),
    );

    // --- Frontend publish: S3 to the site bucket + CloudFront invalidation.
    //     Bucket/distribution live in the frontend stack; scope by name pattern
    //     within this account/region (no cross-stack dependency introduced). ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FrontendS3Publish',
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:GetBucketLocation'],
        resources: [
          `arn:aws:s3:::cloudnautsupportdeskfrontend*`,
          `arn:aws:s3:::cloudnautsupportdeskfrontend*/*`,
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFrontInvalidate',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        // CreateInvalidation does not support resource-level permissions on all
        // partitions; scope to distributions in this account.
        resources: [`arn:aws:cloudfront::${props.account}:distribution/*`],
      }),
    );
  }
}
