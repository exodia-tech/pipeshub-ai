# EXODIA Brain

EXODIA Brain brings your company knowledge into one searchable workspace.

## Signing in

Open https://brain.exodia.ws and use your invited company account. Use **Forgot Password** on the login page if needed. Never send passwords or access tokens to support.

## Support and setup

**Workspace → Usage & costs** shows model usage and cost estimates, with organization-wide analytics and monthly warning budgets for administrators. See [usage analytics](usage-analytics.md) for accounting coverage, pricing and persistence details.

Contact [EXODIA support](mailto:mo@exodiatech.com) for account access, connector setup, AI provider configuration, and deployment help. Administrators manage these settings in Workspace. Access to source content depends on the permissions configured for your organization and connected services.

Company website: https://exodiatech.com

## Software notices

This product is maintained by EXODIA. Original software attribution and license notices are preserved in the repository LICENSE files.

## Release source

Coolify builds this fork's `main` branch with the commit selector set to `HEAD`, using `deployment/docker-compose/docker-compose.exodia.yml`. A source sync is complete for production only after the main-branch deployment finishes and its actual commit and browser health are verified. Upstream is merged into the fork so EXODIA customizations survive; production does not deploy directly from the upstream repository.

The app image and runtime build information use Coolify's `SOURCE_COMMIT`. Database image digests and named volumes stay independent of app releases. Keep the last successful deployment commit in the local deployment checkpoint for rollback.
