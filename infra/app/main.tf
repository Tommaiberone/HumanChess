# Live web app on AWS Lambda, within the always-free tier: two functions from one zip
# package (scripts/build_lambda.py) and a DynamoDB table with provisioned capacity.
# - api: FastAPI behind a public function URL with a sign-in page; serves the frontend,
#   reads Chess.com, and hands every analysis to the worker with an async invoke;
# - worker: Stockfish (fetched from its GitHub release on a cold start) and Maia-3 on
#   numpy (weights in two layers), one job per invocation, progress in the table.
# No ECR, S3 or API Gateway: past the first year none of them has a free tier.

locals {
  prefix         = "smartchess"
  worker_timeout = 900 # seconds: the Lambda maximum, a long game takes a few minutes
  password       = var.app_password != "" ? var.app_password : random_password.app.result
  build          = var.build_dir != "" ? var.build_dir : "${path.module}/../../build/lambda"
}

resource "random_password" "app" {
  length  = 20
  special = false # typed once on a phone
}

# -- data -----------------------------------------------------------------------

# Games, reviews and jobs, one item per document (see smartchess.web.store.DynamoStore).
# The free tier covers 25 RCU and 25 WCU of provisioned capacity per account, not
# on-demand requests; the other tables in this account are all on-demand.
resource "aws_dynamodb_table" "data" {
  name           = local.prefix
  billing_mode   = "PROVISIONED"
  read_capacity  = var.read_capacity
  write_capacity = var.write_capacity
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expires" # jobs, a week after their last update
    enabled        = true
  }
}

# -- package --------------------------------------------------------------------

resource "aws_lambda_layer_version" "deps" {
  layer_name               = "${local.prefix}-deps"
  filename                 = "${local.build}/deps.zip"
  source_code_hash         = filebase64sha256("${local.build}/deps.zip")
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["x86_64"]
}

resource "aws_lambda_layer_version" "maia" {
  for_each                 = toset(["1", "2"])
  layer_name               = "${local.prefix}-maia-${each.key}"
  filename                 = "${local.build}/maia-${each.key}.zip"
  source_code_hash         = filebase64sha256("${local.build}/maia-${each.key}.zip")
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["x86_64"]
}

# -- IAM ------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:BatchGetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.data.arn]
  }
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [data.aws_iam_policy_document.worker.json]
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker.arn]
  }
}

resource "aws_iam_role" "worker" {
  name               = "${local.prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "worker" {
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy_attachment" "logs" {
  for_each   = { worker = aws_iam_role.worker.name, api = aws_iam_role.api.name }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = toset(["worker", "api"])
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 14
}

# -- functions ------------------------------------------------------------------

resource "aws_lambda_function" "worker" {
  function_name                  = "${local.prefix}-worker"
  role                           = aws_iam_role.worker.arn
  runtime                        = "python3.12"
  handler                        = "smartchess.web.aws.worker"
  filename                       = "${local.build}/app.zip"
  source_code_hash               = filebase64sha256("${local.build}/app.zip")
  layers                         = concat([aws_lambda_layer_version.deps.arn], [for k in ["1", "2"] : aws_lambda_layer_version.maia[k].arn])
  architectures                  = ["x86_64"]
  memory_size                    = var.worker_memory
  timeout                        = local.worker_timeout
  reserved_concurrent_executions = var.max_analyses

  environment {
    variables = {
      SMARTCHESS_TABLE        = aws_dynamodb_table.data.name
      SMARTCHESS_MAIA_WEIGHTS = "/opt/maia"
      GROQ_API_KEY            = var.groq_api_key
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.logs]
}

resource "aws_lambda_function_event_invoke_config" "worker" {
  function_name                = aws_lambda_function.worker.function_name
  maximum_retry_attempts       = 0    # a failed job is reported to the UI, never rerun
  maximum_event_age_in_seconds = 3600 # how long a throttled job may wait for a free worker
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.12"
  handler          = "smartchess.web.aws.api"
  filename         = "${local.build}/app.zip"
  source_code_hash = filebase64sha256("${local.build}/app.zip")
  layers           = [aws_lambda_layer_version.deps.arn]
  architectures    = ["x86_64"]
  memory_size      = 1024
  timeout          = 30

  environment {
    variables = {
      SMARTCHESS_TABLE          = aws_dynamodb_table.data.name
      SMARTCHESS_WORKER         = aws_lambda_function.worker.function_name
      SMARTCHESS_WORKER_TIMEOUT = local.worker_timeout
      SMARTCHESS_USER           = var.username
      SMARTCHESS_PASSWORD       = local.password
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.logs]
}

# Public URL; the app shows its own sign-in page. Since October 2025 an auth-type NONE
# URL needs both permissions below, or every request gets a 403. They live in the
# function's resource policy: if a change ever replaces the function under the same
# name (as the switch from image to zip did), apply once more to put them back.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "FunctionUrlAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "FunctionUrlAllowInvokeAction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "*"
  invoked_via_function_url = true
}
