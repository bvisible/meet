# Copyright (c) 2025, Frappe and contributors
# For license information, please see license.txt

from urllib.parse import urlparse

import frappe
from frappe.utils.caching import redis_cache


@redis_cache(ttl=5 * 60)
def get_sfu_config():
	"""Get SFU configuration from site config or defaults"""
	return {
		"sfu_server_url": frappe.conf.get("sfu_server_url", "http://localhost"),
		"sfu_server_port": frappe.conf.get("sfu_server_port", 3000),
		"sfu_secret": frappe.conf.get("sfu_secret", ""),
	}


def get_tenant() -> str:
	"""Return a unique tenant identifier for this Frappe site.

	Used in the SFU JWT payload to isolate rooms per tenant on a
	shared central SFU. MUST be unique per deployment.

	On multi-deploy setups (e.g. Neoffice), every instance uses the
	same logical `frappe.local.site` value (`prod.local`), so it is
	useless as a tenant discriminator. The public hostname, on the
	other hand, is always unique per instance.

	Resolution order:
	1. `sfu_tenant` from site_config — explicit override
	2. `host_name` from site_config (stripped of scheme) — the public
	   URL configured on every Frappe instance
	3. `frappe.local.site` — fallback for dev / single-tenant setups
	"""
	explicit = frappe.conf.get("sfu_tenant")
	if explicit:
		return str(explicit)

	host_name = frappe.conf.get("host_name")
	if host_name:
		parsed = urlparse(host_name)
		# urlparse('https://x') gives hostname='x'; urlparse('x') gives
		# hostname=None — handle both.
		return parsed.hostname or host_name.rstrip("/")

	return frappe.local.site
