variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  description = "AWS CLI profile of the personal account."
  type        = string
  default     = "job-radar"
}

variable "build_dir" {
  description = "Output of scripts/build_lambda.py (default: ../../build/lambda)."
  type        = string
  default     = ""
}

variable "username" {
  description = "Default Chess.com username shown by the app."
  type        = string
  default     = "tommasobersani"
}

variable "app_password" {
  description = "Sign-in password (basic auth user `smartchess` for scripts). Empty: a generated one, see `terraform output password`."
  type        = string
  default     = ""
  sensitive   = true
}

variable "groq_api_key" {
  description = "Groq key for the LLM explanations. Empty: template explanations only."
  type        = string
  default     = ""
  sensitive   = true
}

variable "worker_memory" {
  description = <<-EOT
    Worker memory in MB. Lambda gives CPU in proportion (10240 MB is 6 vCPU), and the
    analysis uses every core, so more memory means a faster review at about the same
    cost. 3008 MB (about 2 vCPU) is this account's limit until AWS raises it.
  EOT
  type        = number
  default     = 3008
}

variable "max_analyses" {
  description = "Analyses running at once (worker reserved concurrency); further jobs wait in the async queue."
  type        = number
  default     = 2
}

# The always-free tier gives 25 RCU and 25 WCU of provisioned capacity per account.
# One user needs little: polling reads a job every 1-1.5 s, the worker writes one
# every 2 s, and bigger bursts (the game list, a finished review) use burst capacity.
variable "read_capacity" {
  type    = number
  default = 5
}

variable "write_capacity" {
  type    = number
  default = 10 # the rate-limit counters and the anonymous visit counters (the free tier allows 25 per account)
}

variable "site_origin" {
  description = "Origin of the public site (https://host, no path): the only page allowed to call the explanation proxy."
  type        = string
  default     = "https://d10viis4vhdzq8.cloudfront.net"
}

variable "llm_per_ip_hour" {
  description = "Explanation requests one visitor may make per hour (a review is about 10)."
  type        = number
  default     = 40
}

variable "llm_per_day" {
  description = "Explanation requests the proxy answers per day, whoever asks: keeps the Groq free quota from running out."
  type        = number
  default     = 1500
}

variable "stats_campaigns" {
  description = "Names a link may carry as ?from=<name> to count visits per post (comma separated, [a-z0-9] only)."
  type        = string
  default     = "chess,chessbeginners,lichess,chessprogramming,hn,x,friends"
}
