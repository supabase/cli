import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { S3Client as AwsS3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, exit } from "node:process";

async function main() {
  const client = new S3Client({
    endPoint: "http://127.0.0.1:54321/storage/v1/s3",
    accessKey: "625729a08b95bf1b7ff351a663f3a23c",
    secretKey:
      "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    region: env.S3_REGION ?? "local",
    bucket: env.S3_BUCKET ?? "test",
    pathStyle: true,
  });
  const awsClient = new AwsS3Client({
    region: env.S3_REGION ?? "local",
    endpoint: "http://127.0.0.1:54321/storage/v1/s3",
    credentials: {
      accessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
      secretAccessKey:
        "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    },
  });

  const objectKey = "test-file.txt";

  try {
    const url = await client.getPresignedUrl("PUT", objectKey, {
      expirySeconds: 60,
      parameters: {
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
        "x-id": "PutObject",
      },
    });

    console.log("Presigned PUT URL:", url);

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "local presign repro",
    });

    console.log("Local storage response:", response.status);
    console.log("Response body:", await response.text());
  } catch (error) {
    console.error(error);
  }
  try {
    // Try with awsClient to get a presigned url
    const command = new GetObjectCommand({
      Bucket: "test",
      Key: objectKey,
    });
    const url = await getSignedUrl(awsClient, command, { expiresIn: 60 });
    console.log("Presigned GET URL:", url);
    const response = await fetch(url);
    console.log("AWS S3 response:", response.status);
    console.log("Response body:", await response.text());
  } catch (error) {
    console.error(error);
  }
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
