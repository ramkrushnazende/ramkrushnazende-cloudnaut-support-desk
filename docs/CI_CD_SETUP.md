# CI/CD Setup — one-time steps

These are the manual steps required to activate the pipeline. The agent cannot
perform them (they need repo-admin and an authorized AWS deploy).

## 1. Deploy the CDK change that creates the OIDC role
The GitHub OIDC provider + deploy role live in `infra/lib/github-oidc.ts`,
wired into `CloudnautSupportDeskStack`. Deploy it (review the diff first):

```bash
cd infra
npm ci && npm run build
npx cdk diff CloudnautSupportDeskStack --profile ram-cloudnaut \
  -c cognitoUserPoolId=ap-south-1_ywRrGmxpM -c cognitoAppClientId=36hud2677sjbeb1qjov197fmai
# Expect ADDITIONS only: Custom::AWSCDKOpenIdConnectProvider + IAM role/policy.
npx cdk deploy CloudnautSupportDeskStack --profile ram-cloudnaut \
  -c cognitoUserPoolId=ap-south-1_ywRrGmxpM -c cognitoAppClientId=36hud2677sjbeb1qjov197fmai
```
If the account already has a `token.actions.githubusercontent.com` provider,
add `-c createGithubOidcProvider=false` so CDK references it instead of creating
a duplicate. (Verified absent on 2026-10-14, so default `true` is correct.)

Copy the `GitHubActionsDeployRoleArn` output.

## 2. GitHub repository configuration
- **Secret** `AWS_DEPLOY_ROLE_ARN` = the role ARN from step 1.
  (This is an ARN, not a credential — the only "secret" needed.)
- **Environment** `production`:
  - Settings → Environments → New environment → `production`.
  - Add **required reviewers** (yourself/team) so prod deploys gate on approval.
  - Optionally restrict deployment branches to `main`.
- **Branch protection** on `main`: require the CI checks
  (`Python tests`, `Frontend`, `CDK`) to pass before merge; require PR review.

## 3. Verify OIDC trust
The role trusts exactly:
`repo:ramkrushnazende/ramkrushnazende-cloudnaut-support-desk:ref:refs/heads/main`
with audience `sts.amazonaws.com`. Deploys from other branches will be denied
by STS — intended.

## Public vs secret values
| Value | Where | Secret? |
|---|---|---|
| Cognito User Pool ID / App Client ID | workflow env, `.env.production`, CDK context | Public |
| API Gateway URL, CloudFront URL/ID, bucket name, instance id, account id | workflow env / stack outputs | Public |
| `AWS_DEPLOY_ROLE_ARN` | GitHub secret | ARN (not a credential) |
| DB URL, `AUTH_SECRET_KEY`, SMTP creds | AWS Secrets Manager → instance `app.env` | Secret — never in GitHub |

No long-lived AWS access keys are stored anywhere in GitHub.
