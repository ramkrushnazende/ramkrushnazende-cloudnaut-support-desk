import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface FrontendStackProps extends StackProps {
  /**
   * Absolute path to the built frontend assets (the Vite `dist/` directory).
   * BucketDeployment uploads this to the private S3 bucket.
   */
  readonly frontendDistPath: string;
}

/**
 * CloudnautSupportDeskFrontendStack — static hosting for the React (Vite)
 * frontend. Completely separate from the backend stack so the deployed
 * CloudnautSupportDeskStack is never touched.
 *
 * Architecture:
 *   User (HTTPS)
 *     -> CloudFront (default *.cloudfront.net cert, redirect HTTP->HTTPS)
 *          -> Origin Access Control (OAC)
 *          -> PRIVATE S3 bucket (BlockPublicAccess=ALL)
 *     SPA fallback: 403/404 -> /index.html (200) so refreshes and the
 *     ?reset_token=... root link resolve to the SPA.
 *
 * The frontend calls the existing API Gateway directly from the browser
 * (VITE_API_URL baked in at build time); API traffic does NOT go through
 * CloudFront. No public bucket, no S3 website hosting, no Route 53/custom
 * domain.
 */
export class FrontendStack extends Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // Private bucket for the built assets. Not publicly accessible; CloudFront
    // reaches it via OAC only. DESTROY/autoDelete for a learning stack.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution. S3BucketOrigin.withOriginAccessControl creates
    // an Origin Access Control (OAC) and grants the distribution read access
    // to the private bucket via a bucket policy scoped to this distribution.
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Cloudnaut Support Desk frontend',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA fallback: the app has no server-side routes, and the password-reset
      // flow uses `/?reset_token=...` on the root. Any non-asset path (or a
      // refresh) must return index.html with 200 so the SPA bootstraps.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    // Upload the built assets and invalidate the CloudFront cache on deploy.
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(props.frontendDistPath)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public CloudFront URL for the frontend (add this origin to the backend CORS allow_origins)',
    });
    new CfnOutput(this, 'FrontendBucketName', {
      value: siteBucket.bucketName,
      description: 'Private S3 bucket holding the frontend build (served only via CloudFront OAC)',
    });
    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID (for cache invalidations)',
    });
  }

  /** Default dist path: workspace/frontend/dist relative to the infra project. */
  static defaultDistPath(): string {
    return path.resolve(__dirname, '..', '..', 'workspace', 'frontend', 'dist');
  }
}
