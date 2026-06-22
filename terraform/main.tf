terraform {
  required_version = ">= 1.5"

  required_providers {
    newrelic = {
      source  = "newrelic/newrelic"
      version = "~> 3.0"
    }
  }
}

locals {
  nerdgraph_url = var.staging ? "https://staging-api.newrelic.com/graphql" : null
}

provider "newrelic" {
  account_id       = var.account_id
  api_key          = var.api_key
  region           = upper(var.region)
  # nerdgraph_api_url is marked deprecated in the provider and emits a
  # deprecation warning — that warning is expected when var.staging = true.
  # It has no effect when var.staging = false (null is passed and the
  # provider uses its default endpoint).
  nerdgraph_api_url = local.nerdgraph_url
}
