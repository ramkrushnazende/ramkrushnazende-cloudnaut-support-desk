# Cloudnaut Support Desk — AWS CDK Infrastructure (`infra/`)

One AWS CDK (TypeScript) **stack** that deploys the Cloudnaut Support Desk backend and the minimum AWS resources it needs. Built to be simple and readable for learning AWS deployment: **one stack, one deploy command, one teardown command.**

> Infrastructure only — this project does not modify anything under `workspace/`, and nothing here deploys on its own. Review and deploy explicitly.

## Architecture (single stack)

```
Internet
  │  HTTPS
  ▼
API Gateway (HTTP API)            ← public entry point
  │  HTTP proxy integration ($default + /{proxy+})
  ▼
EC2 (public subnet, Docker)       ← api :4000  →  backend :8001 (internal only)
  ├─ RDS PostgreSQL  (private isolated subnet, 5432 from EC2 SG only)
  ├─ S3              (attachments, private, SSE, SSL-only)
  └─ Secrets Manager (RDS creds + AUTH_SECRET_KEY)
```

All of the above is created by **one** stack: `CloudnautSupportDeskStack` (`lib/cloudnaut-support-desk-stack.ts`).

### What was intentionally left out (and why)
- **No NAT Gateway** — EC2 is in a public subnet with a public IP and reaches ECR/Secrets/S3/SES via the Internet Gateway. Removes the biggest hourly cost (~$32/mo). RDS stays private.
- **No internal ALB + VPC Link** — API Gateway proxies directly to the EC2 public DNS on `:4000`. Fewer moving parts, no ALB hourly cost.
- **No Multi-AZ / Auto Scaling / separate monitoring stack** — not needed to run the app.

### Still private / still secure
- RDS: isolated subnets, `PubliclyAccessible: false`, encrypted, reachable only from the EC2 security group.
- Backend container port `8001` is never published to the host or opened in any security group — only `api :4000` is exposed.
- Secret values live in Secrets Manager and are fetched by the instance at boot (0600 env file); they are not in source, not in CloudFormation outputs, and not in logs.

## Prerequisites

1. AWS account + credentials (profile) for the target account/region (default `ap-south-1`).
2. One-time per account/region: `npx cdk bootstrap aws://<account>/<region>`.
3. Two ECR repositories with the app images pushed (tag `latest`):
   - `cloudnaut-support-desk-api`
   - `cloudnaut-support-desk-backend`
   (The instance pulls these at boot; if they aren't present yet it retries — push them, then `systemctl restart cloudnaut` on the instance.)
4. **Email (optional / deferred):** SES is not provisioned here. The app starts fine without it (password-reset email returns 503 until configured). To enable later: verify an SES identity, create SES SMTP credentials, and set `SMTP_USERNAME`/`SMTP_PASSWORD` in the app secret (plus `SMTP_HOST`/`SMTP_FROM_EMAIL` in the instance env).

## Commands

```bash
cd infra
npm install

# verify (no AWS calls)
npm run typecheck
npm test
npx cdk synth

# one deploy, one teardown
npx cdk deploy  CloudnautSupportDeskStack --profile <your-profile>
npx cdk destroy CloudnautSupportDeskStack --profile <your-profile>
```

Account/region default to `771675725990` / `ap-south-1` and respect `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`.

### Cognito runtime configuration

The EC2 bootstrap writes the Cognito auth mode, User Pool ID, and public SPA
App Client ID into `/opt/cloudnaut/app.env`; both application containers read
that file. Supply the IDs as CDK context values on every synth/diff/deploy
command (they are public identifiers, not secrets):

```bash
-c cognitoUserPoolId=ap-south-1_9btqlmF3a \
-c cognitoAppClientId=5vg4ssrhma5kacpdns3830mg1r
```

Review `npx cdk diff` before deploying. A change to EC2 UserData can require
replacement of the EC2 instance; do not deploy if the diff reports replacement
until an in-place production rollout has been planned.

## After deploy — verify

The stack prints these outputs (`cdk deploy` shows them; no secret values):

| Output | Use |
|--------|-----|
| `ApiUrl` | Public API Gateway URL — set as the frontend `VITE_API_URL`; test with `curl "$ApiUrl/health"` (expect `200`) |
| `InstancePublicDns` | EC2 host; SSM in and run `docker ps` to see `app_api` + `app_backend` |
| `AttachmentsBucketName` | S3 bucket for attachments |
| `DbEndpoint` | Private RDS endpoint |
| `DbSecretArn` / `AppSecretArn` | Secrets Manager ARNs (values retrieved by the instance role) |

First run (once containers are up): run DB migrations + create the first admin inside the backend container, e.g. (via SSM):
```
docker exec app_backend python -m app.initialize_db
docker exec -it app_backend python -m app.bootstrap_admin --name Admin --email admin@example.com
```

## Teardown

```bash
npx cdk destroy CloudnautSupportDeskStack --profile <your-profile>
```
This stack uses `RemovalPolicy.DESTROY` on RDS and S3 (learning setup), so teardown removes them and their data. Do not use these settings for data you want to keep.

## Cost notes (verify current prices in the AWS pricing pages)

Ongoing-cost resources in this stack:
- **EC2** `t3.small` — the main hourly cost.
- **RDS** `db.t4g.micro` (single-AZ, 20 GB gp2) — second hourly cost.
- **Public IPv4** on the EC2 instance — small hourly charge per address.
- **API Gateway HTTP API** — per-request (negligible at low volume).
- **S3** / **ECR** / **Secrets Manager** — storage + a couple of secrets (small).
- **No NAT Gateway, no ALB** — the two biggest fixed costs are intentionally avoided.

> Legacy multi-stack files (`network-stack.ts`, `security-stack.ts`, `storage-stack.ts`, `database-stack.ts`, `compute-stack.ts`, `api-stack.ts`, `monitoring-stack.ts`, `config/`) remain in `lib/`/`config/` for reference but are **no longer instantiated** by `bin/infra.ts`. They can be deleted once you're comfortable with the single-stack setup.
