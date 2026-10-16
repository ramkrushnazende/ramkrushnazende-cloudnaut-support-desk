# Rollback Runbook

Rollback restores the application to a previous **image SHA** and healthy state.
It never touches the database, attachments, or Cognito.

## Automatic rollback (built into deploy)
The `deploy-backend` SSM step backs up `/opt/cloudnaut/docker-compose.prod.yml`
to `.bak` before changing it. If the post-deploy health check (`:4000` and
`:8001` `/health`) fails, it restores the `.bak` compose, re-pulls, and restarts
`cloudnaut.service`, then exits non-zero so the run is marked failed. No manual
action is needed for a failed health check during deploy.

## Manual rollback to a known-good SHA
Pick the last healthy commit SHA (from a previous green deploy summary):
```bash
GOOD_SHA=<previous-good-sha>
REG=771675725990.dkr.ecr.ap-south-1.amazonaws.com
aws ssm send-command --instance-ids i-0f35e03d7af81e88d \
  --document-name AWS-RunShellScript --profile ram-cloudnaut --region ap-south-1 \
  --parameters commands='["cd /opt/cloudnaut && aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin '"$REG"' && sed -i -E \"s#image: .*/cloudnaut-support-desk-backend:.*#image: '"$REG"'/cloudnaut-support-desk-backend:'"$GOOD_SHA"'#\" docker-compose.prod.yml && sed -i -E \"s#image: .*/cloudnaut-support-desk-api:.*#image: '"$REG"'/cloudnaut-support-desk-api:'"$GOOD_SHA"'#\" docker-compose.prod.yml && docker compose -f docker-compose.prod.yml pull && systemctl restart cloudnaut.service"]'
```
The SHA image must still exist in ECR (lifecycle policy retains recent images).

## Verify rollback
```bash
curl -fsS https://dzgpuxnv7i.execute-api.ap-south-1.amazonaws.com/health
# and via SSM: docker ps, docker logs app_api --tail 50
```
Confirm the running image matches `$GOOD_SHA`:
```bash
aws ssm send-command --instance-ids i-0f35e03d7af81e88d --document-name AWS-RunShellScript \
  --profile ram-cloudnaut --region ap-south-1 \
  --parameters commands='["docker inspect --format '"'"'{{.Config.Image}}'"'"' app_api app_backend"]'
```

## Frontend rollback
Re-run the deploy workflow from the previous good commit (re-dispatch on that
SHA), or re-upload a previously built `dist/` to the site bucket and invalidate
CloudFront. `index.html` is `no-cache`, so rollback is visible immediately after
invalidation.

## Hard rules
- NEVER drop, truncate, reset, or recreate the database to recover a deploy.
- NEVER delete the attachments bucket or Cognito pool.
- Rollback is image-only; schema changes use expand/contract and are reverted
  through their own backward-compatible migration, not by data destruction.
