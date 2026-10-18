terraform {
  required_version = ">= 1.10" # native S3 state locking (use_lockfile)

  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
  }

  # Same state bucket as the showcase (infra/), under its own key.
  backend "s3" {
    bucket       = "job-radar-tfstate-586250839220"
    key          = "smartchess-app.tfstate"
    region       = "eu-west-1"
    profile      = "job-radar"
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = { project = "smartchess", component = "app", managed-by = "terraform" }
  }
}
