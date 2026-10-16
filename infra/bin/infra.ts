#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudnautSupportDeskStack } from '../lib/cloudnaut-support-desk-stack';
import { FrontendStack } from '../lib/frontend-stack';

/**
 * Cloudnaut Support Desk — ONE CDK app, ONE stack.
 *
 *   cdk deploy CloudnautSupportDeskStack
 *   cdk destroy CloudnautSupportDeskStack
 *
 * Simple inline config (no multi-env abstraction). Account/region default to
 * the project target (ap-south-1) but respect CDK_DEFAULT_* if set. No secret
 * values live here — only names, sizes, and the region.
 */
const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT ?? '771675725990';
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-south-1';

new CloudnautSupportDeskStack(app, 'CloudnautSupportDeskStack', {
  env: { account, region },
  description: 'Cloudnaut Support Desk — single-stack backend infrastructure',

  // Container images (Amazon ECR). Push these before/just after deploy.
  apiEcrRepo: 'cloudnaut-support-desk-api',
  backendEcrRepo: 'cloudnaut-support-desk-backend',
  imageTag: 'latest',

  // Database.
  postgresMajorVersion: '16',
  databaseName: 'cloudnaut_db',
  databaseUsername: 'cloudnaut',

  tags: {
    Application: 'cloudnaut-support-desk',
    ManagedBy: 'cdk',
  },
});

// Frontend static hosting — a SEPARATE stack. It does not reference or modify
// the backend stack, so deploying/destroying it never touches the backend.
//
//   cdk deploy  CloudnautSupportDeskFrontendStack
//   cdk destroy CloudnautSupportDeskFrontendStack
new FrontendStack(app, 'CloudnautSupportDeskFrontendStack', {
  env: { account, region },
  description: 'Cloudnaut Support Desk — frontend (S3 + CloudFront + OAC)',
  frontendDistPath: FrontendStack.defaultDistPath(),
  tags: {
    Application: 'cloudnaut-support-desk',
    ManagedBy: 'cdk',
  },
});

app.synth();
