# Read-only showcase: the static export on a private S3 bucket behind CloudFront.
# No backend, no secrets: the reviews are computed locally and uploaded as JSON.

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  prefix    = "smartchess"
  site_dir  = var.site_dir != "" ? var.site_dir : "${path.module}/../site"
  protected = var.password != ""
  content_types = {
    html        = "text/html; charset=utf-8"
    js          = "text/javascript; charset=utf-8"
    css         = "text/css; charset=utf-8"
    json        = "application/json; charset=utf-8"
    svg         = "image/svg+xml"
    png         = "image/png"
    ico         = "image/x-icon"
    wasm        = "application/wasm"
    mjs         = "text/javascript; charset=utf-8"
    woff2       = "font/woff2"
    onnx        = "application/octet-stream"
    webmanifest = "application/manifest+json"
  }
  # The big engine files never change under the same name: let browsers keep them a week.
  long_cache = toset(["wasm", "onnx", "woff2"])
  # AWS managed cache policy "CachingOptimized" (honours the objects' Cache-Control)
  cache_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  # AWS managed response headers policy "SecurityHeadersPolicy": HSTS, nosniff,
  # X-Frame-Options DENY, Referrer-Policy. The CSP is a <meta> tag of index.html.
  security_headers = "67f7725c-6f97-4210-82d7-5512b31e9d03"
}

resource "aws_s3_bucket" "site" {
  bucket = "${local.prefix}-site-${random_id.suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "site" {
  for_each     = fileset(local.site_dir, "**")
  bucket       = aws_s3_bucket.site.id
  key          = each.value
  source       = "${local.site_dir}/${each.value}"
  etag         = filemd5("${local.site_dir}/${each.value}")
  content_type = lookup(local.content_types, reverse(split(".", each.value))[0], "application/octet-stream")
  # File names carry no hash: browsers revalidate the page and its code on every load (a
  # 304 is a few bytes), so a reload right after a deploy gets it; deploy.sh also invalidates.
  cache_control = contains(local.long_cache, reverse(split(".", each.value))[0]) ? "public, max-age=604800" : "no-cache"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.prefix}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })
}

resource "aws_cloudfront_function" "basic_auth" {
  count   = local.protected ? 1 : 0
  name    = "${local.prefix}-basic-auth"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = templatefile("${path.module}/basic_auth.js", { credential = base64encode("smartchess:${var.password}") })
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "smartchess showcase"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.cache_optimized
    response_headers_policy_id = local.security_headers
    compress                   = true

    dynamic "function_association" {
      for_each = local.protected ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.basic_auth[0].arn
      }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
