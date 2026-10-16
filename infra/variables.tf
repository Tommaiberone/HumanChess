variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  description = "AWS CLI profile of the personal account."
  type        = string
  default     = "job-radar"
}

variable "site_dir" {
  description = "Output of `smartchess export` (default: ../site)."
  type        = string
  default     = ""
}

variable "password" {
  description = "Empty: public site. Otherwise basic auth with user `smartchess` and this password."
  type        = string
  default     = ""
  sensitive   = true
}
