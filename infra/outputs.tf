output "url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}/"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "bucket" {
  value = aws_s3_bucket.site.id
}
