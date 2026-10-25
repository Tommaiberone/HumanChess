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

output "llm_url" {
  description = "Explanation proxy for the public site (scripts/deploy.sh passes it to the export)."
  value       = aws_lambda_function_url.llm.function_url
}

output "stats_url" {
  description = "Anonymous counters for the public site (scripts/deploy.sh passes it to the export)."
  value       = aws_lambda_function_url.stats.function_url
}
