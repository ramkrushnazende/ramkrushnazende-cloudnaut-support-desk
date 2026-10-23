#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudnautSupportDeskLambdaStack } from '../lib/cloudnaut-support-desk-lambda-stack';
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

new CloudnautSupportDeskLambdaStack(app, 'CloudnautSupportDeskLambdaStack', {
  env: { account, region },
  description: 'Cloudnaut Support Desk — single-stack backend infrastructure',

  // Combined Lambda container image in Amazon ECR.
  lambdaEcrRepo: 'cloudnaut-support-desk-lambda',
  imageTag: process.env.CDK_IMAGE_TAG ?? 'latest',

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
