# Deployment Runbook

## Normal deployment (automated)
1. Open a PR into `main`. CI (`ci.yml`) runs: Python tests, frontend tests+build, CDK test+synth.
2. Get review approval; merge to `main`.
3. `deploy.yml` runs on the push to `main`. The `production` environment gate
   requires a reviewer to approve the run.
4. The pipeline builds SHA-tagged images, deploys via SSM, publishes the
   frontend, invalidates CloudFront, and health-checks everything.
5. Check the run summary for the deployed SHA.

## Infrastructure changes (CDK)
Infra is NOT auto-deployed by the pipeline (safety). To change infrastructure:
```bash
cd infra && npm run build
npx cdk diff  CloudnautSupportDeskStack --profile ram-cloudnaut \
  -c cognitoUserPoolId=ap-south-1_9btqlmF3a -c cognitoAppClientId=5vg4ssrhma5kacpdns3830mg1r
# Review for replacements/deletions/SG/IAM/DB changes. STOP if anything would
# replace EC2/RDS/S3/Cognito/CloudFront. Then:
npx cdk deploy CloudnautSupportDeskStack --profile ram-cloudnaut \
  -c cognitoUserPoolId=ap-south-1_9btqlmF3a -c cognitoAppClientId=5vg4ssrhma5kacpdns3830mg1r
```
Frontend stack deploy requires a built `workspace/frontend/dist` (asset source).

## Manual backend deploy (if needed, mirrors the SSM job)
```bash
SHA=<git-sha>; REG=771675725990.dkr.ecr.ap-south-1.amazonaws.com
aws ssm send-command --instance-ids i-0f35e03d7af81e88d \
  --document-name AWS-RunShellScript --profile ram-cloudnaut --region ap-south-1 \
  --parameters commands='["cd /opt/cloudnaut && aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin '"$REG"' && sed -i -E \"s#image: .*/cloudnaut-support-desk-backend:.*#image: '"$REG"'/cloudnaut-support-desk-backend:'"$SHA"'#\" docker-compose.prod.yml && sed -i -E \"s#image: .*/cloudnaut-support-desk-api:.*#image: '"$REG"'/cloudnaut-support-desk-api:'"$SHA"'#\" docker-compose.prod.yml && docker compose -f docker-compose.prod.yml pull && systemctl restart cloudnaut.service"]'
```

## Health checks
- Backend internal: `docker exec app_backend` → `http://localhost:8001/health`.
- API (on host): `curl http://localhost:4000/health`.
- API Gateway (public): `curl https://dzgpuxnv7i.execute-api.ap-south-1.amazonaws.com/health`.
- Frontend: `curl https://d26e7v7avs1w1m.cloudfront.net` (expect SPA root div).

## Diagnosing failures
- **GitHub Actions**: open the failed job logs. OIDC errors → check `AWS_DEPLOY_ROLE_ARN` secret + trust policy branch.
- **Docker build**: verify contexts (backend = repo root; api = `workspace/api`) and `.dockerignore`.
- **ECR push denied**: deploy role `EcrPushPull` scope / repo names.
- **SSM**: `aws ssm get-command-invocation --command-id <id> --instance-id i-0f35e03d7af81e88d` for sanitized stdout/stderr; `aws ssm describe-instance-information` for agent/ping.
- **Container logs on host (via SSM)**: `docker logs app_api --tail 100`, `docker logs app_backend --tail 100`.
- **CloudWatch**: EC2/CloudFront logs where configured.
- **CloudFront stale**: confirm invalidation completed; `index.html` is `no-cache`.

## Operations requiring manual approval
- Any CDK deploy (infra).
- Production database migrations (see `docs/` and the Database Safety section of the task).
- Switching `AUTH_MODE` (legacy/dual/cognito) — never automated.
- Cognito user migration (`workspace/backend/app/cognito_migration.py`) — separate, approved, one-time.
