PonsWarp backend parity v1

backend-parity.mjs is a read-only baseline evidence generator. Run it from the
repository root with:

  node scripts/backend-parity.mjs

It inventories source, Cargo metadata, migrations, README/config examples, and
example environment files in PonsWarp/signaling-rs and ponswarp-signaling-rs.
Files are represented by deterministic SHA-256 checksums. Environment values
are never emitted: only key names, whether a non-empty default is present, and
secret-key classification are recorded.

The tool excludes secrets, build output, dependency trees, and VCS metadata.
Migration order and checksums are therefore covered by the inventory. Routes
and protocol variants are evidence extracted from source, not hand-authored
claims. The expected-routes.json file intentionally starts with empty
placeholders. Later stages must populate those arrays from approved runtime
contract inputs; until then the tool fails closed.

A nonzero exit means a backend tree is missing, a file/environment/route/
protocol difference is unexplained, or runtime route/protocol contract inputs
are absent. This baseline does not run, build, lint, or mutate either backend.
