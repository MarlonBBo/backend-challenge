#!/usr/bin/env sh
set -eu

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT_ID="000000000000"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wager-events.fifo"

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${DLQ_NAME}"
QUEUE_ATTRIBUTES="$(printf \
  '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' \
  "$DLQ_ARN")"

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$QUEUE_NAME" \
  --attributes "$QUEUE_ATTRIBUTES"

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$EVENTS_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

