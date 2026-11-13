# Native group scope controls

Requested scope: reuse the native OAuth scope catalogue and enforcement for access-group feature limits. Keep content permissions, organization roles and token grants as independent upper limits.

## Contract

- No feature policy means existing behavior. A configured policy is an allowlist of native member-eligible action scopes; an empty list denies scoped actions.
- Every applicable group's allowlist must allow an action. Removing a restriction cannot override another group's restriction. Groups do not confer admin rights.
- Native scope checks keep their existing OR semantics, but one action must be allowed by both the effective group limit and the token grant. Direct Python routes and MCP must apply the same restriction.
- Live admins bypass group feature limits for recovery; their OAuth/PAT scopes still apply. Service-account identities do not become admins.
- Resolve membership and policy live; never trust a client scope-limit claim. Policy read failure denies the scoped operation. Existing sign-in audit outage behavior is unchanged.
- Store the optional feature allowlist alongside the existing resource policy and revision. Existing content-policy saves preserve the allowlist. Admin writes use the existing permission-change audit path.

## Implementation and verification

In progress. Reuse the previously agreed authenticated API, permission-change and actual UI test seams. Detailed coverage, screenshots and deployment state will be recorded after implementation.
