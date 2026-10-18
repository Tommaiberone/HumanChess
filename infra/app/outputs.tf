output "url" {
  value = aws_lambda_function_url.api.function_url
}

output "password" {
  description = "Sign-in password."
  value       = local.password
  sensitive   = true
}

output "table" {
  value = aws_dynamodb_table.data.name
}
