# Invite-only connections

Host discovery has been removed from HostAI at the user’s request. There is no
Find a host page, public listing, registry service, or directory publication API.
Legacy `HOSTAI_DIRECTORY_URL` and `HOSTAI_DIRECTORY_ALLOW_LOOPBACK` settings have
no effect. HostAI does not publish or search host metadata.

Hosts privately send an invitation containing their guest address and an expiring
access key. Alternatively, they can send the guest address to an intended visitor,
enable access requests and approve that visitor in the app. A guest address alone
does not grant chat permission. See [guest access](guest-access.md) and
[access requests](access-requests.md).

Cloudflare Quick Tunnel transport remains available for remote guests. This is
invite-only access, not a private VPN: the endpoint is internet-reachable, holders
can forward a bearer key, and Cloudflare can see relayed messages and keys. Stop
sharing closes public access; revoking a key ends its permission.

Old third-party listings are not remotely erased by upgrading HostAI. The removed
reference registry expired fresh entries after 90 seconds without a heartbeat;
other services may retain copies. Previously stored directory identities and
browser bookmarks are unused and are not automatically deleted from user storage.
