// GET /api/spec.yaml — hand-written OpenAPI 3.1 covering every v1 endpoint plus
// the auth.md / OAuth surfaces. Served as a route handler (new Response(text)).
// Validated locally with @redocly/cli (a Spectral/OpenAPI validator) before ship.
export const dynamic = "force-dynamic";

const SPEC = `openapi: 3.1.0
info:
  title: justhtml.sh API
  version: "1.0.0"
  description: |
    An agent-first minimal HTML document host. Agents self-onboard via the
    auth.md service_auth flow (see https://justhtml.sh/auth.md), receive a
    long-lived API key, and publish HTML documents to stable URLs.

    Terse usage with curl examples: https://justhtml.sh/llms.txt
  license:
    name: Proprietary
    url: https://justhtml.sh/
servers:
  - url: https://justhtml.sh
    description: Production
tags:
  - name: auth
    description: auth.md service_auth registration + OAuth token/revoke
  - name: discovery
    description: Machine-readable OAuth discovery metadata
  - name: docs
    description: Document CRUD, patch editing, versions
  - name: sharing
    description: Per-document grants (email or domain)
paths:
  /agent/identity:
    post:
      tags: [auth]
      summary: Start a service_auth registration
      description: |
        Creates a pending registration (no user account is created yet) and
        returns a claim_token plus a claim ceremony block. Surface the
        user_code and verification_uri to the human in one message.
      operationId: startRegistration
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [type, login_hint]
              properties:
                type:
                  type: string
                  enum: [service_auth]
                login_hint:
                  type: string
                  format: email
                  example: you@example.com
      responses:
        "200":
          description: Pending registration created
          content:
            application/json:
              schema:
                type: object
                properties:
                  registration_id: { type: string }
                  registration_type: { type: string, enum: [service_auth] }
                  claim_url: { type: string, format: uri }
                  claim_token:
                    type: string
                    description: Secret; returned once. Hold in memory only.
                  claim_token_expires: { type: string, format: date-time }
                  post_claim_scopes:
                    type: array
                    items: { type: string }
                  claim:
                    type: object
                    properties:
                      user_code: { type: string, example: "428117" }
                      expires_in: { type: integer, example: 600 }
                      verification_uri: { type: string, format: uri }
                      interval: { type: integer, example: 5 }
        "400":
          description: Bad body, bad login_hint, or an unsupported registration type
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AgentError" }
        "429":
          $ref: "#/components/responses/RateLimited"
  /agent/identity/claim:
    post:
      tags: [auth]
      summary: Re-mint an expired user_code
      description: |
        Invalidates the prior user_code + verification link and mints fresh
        ones (the 24h registration window must still be open). A corrected
        email updates the registration's login_hint.
      operationId: remintClaim
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [claim_token, email]
              properties:
                claim_token: { type: string }
                email: { type: string, format: email }
      responses:
        "200":
          description: Fresh claim attempt
          content:
            application/json:
              schema:
                type: object
                properties:
                  registration_id: { type: string }
                  claim_attempt_id: { type: string }
                  status: { type: string, example: initiated }
                  expires_at: { type: string, format: date-time }
                  claim_attempt:
                    type: object
                    properties:
                      user_code: { type: string }
                      expires_in: { type: integer }
                      verification_uri: { type: string, format: uri }
                      interval: { type: integer }
        "400": { description: Bad body, content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } } }
        "401": { description: Unknown claim_token, content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } } }
        "409": { description: Already claimed, content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } } }
        "410": { description: Registration window closed, content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } } }
        "429": { $ref: "#/components/responses/RateLimited" }
  /oauth2/token:
    post:
      tags: [auth]
      summary: Poll the claim grant for the API key
      description: |
        RFC 8628-style polling. While the human has not finished, returns 400
        authorization_pending (or slow_down if polled under 5s apart). On
        confirm, returns the long-lived API key exactly once.
      operationId: claimGrantToken
      security: []
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [grant_type, claim_token]
              properties:
                grant_type:
                  type: string
                  enum: ["urn:workos:agent-auth:grant-type:claim"]
                claim_token: { type: string }
      responses:
        "200":
          description: Credential issued (once)
          headers:
            Cache-Control: { schema: { type: string }, description: no-store }
          content:
            application/json:
              schema:
                type: object
                properties:
                  access_token: { type: string, example: jh_live_... }
                  token_type: { type: string, enum: [Bearer] }
                  scope: { type: string, example: "docs.read docs.write" }
                  credential_type: { type: string, enum: [api_key] }
                  registration_id: { type: string }
        "400":
          description: |
            OAuth error envelope. error one of: authorization_pending,
            slow_down, expired_token, invalid_grant, invalid_request,
            unsupported_grant_type.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/OAuthError" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /oauth2/revoke:
    post:
      tags: [auth]
      summary: Revoke an API key (RFC 7009)
      description: Idempotent. Returns 200 with an empty body whether or not the token existed.
      operationId: revokeToken
      security: []
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [token]
              properties:
                token: { type: string }
                token_type_hint: { type: string, enum: [access_token] }
      responses:
        "200": { description: Revoked (or no-op); empty body }
        "400": { description: Malformed body, content: { application/json: { schema: { $ref: "#/components/schemas/OAuthError" } } } }
        "429": { $ref: "#/components/responses/RateLimited" }
  /.well-known/oauth-protected-resource:
    get:
      tags: [discovery]
      summary: RFC 9728 protected-resource metadata
      operationId: protectedResourceMetadata
      security: []
      responses:
        "200":
          description: Resource metadata
          content: { application/json: { schema: { type: object } } }
  /.well-known/oauth-authorization-server:
    get:
      tags: [discovery]
      summary: RFC 8414 authorization-server metadata (with agent_auth block)
      operationId: authServerMetadata
      security: []
      responses:
        "200":
          description: Authorization-server metadata
          content: { application/json: { schema: { type: object } } }
  /api/v1/docs:
    post:
      tags: [docs]
      summary: Create a document
      operationId: createDoc
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [html]
              properties:
                html: { type: string, maxLength: 2097152 }
                title: { type: string, maxLength: 300 }
                public: { type: boolean, default: false }
      responses:
        "201":
          description: Created
          content: { application/json: { schema: { $ref: "#/components/schemas/OwnerDoc" } } }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Quota" }
        "413": { $ref: "#/components/responses/TooLarge" }
        "429": { $ref: "#/components/responses/RateLimited" }
    get:
      tags: [docs]
      summary: List documents (owned, shared, or both)
      description: |
        Lists documents by scope. Every item carries an access role
        (owner|editor|commenter|viewer). For a doc matched by both an email
        grant and a domain grant, the email grant wins (precedence ladder).
        Owned items additionally carry view_token; shared items do not (the
        view token is an owner-only capability). The web equivalent for a
        signed-in human is https://justhtml.sh/docs.
      operationId: listDocs
      parameters:
        - name: scope
          in: query
          description: |
            owned (default): docs the caller owns. shared: docs granted to the
            caller's email or email-domain, excluding docs the caller owns.
            all: owned then shared.
          schema: { type: string, enum: [owned, shared, all], default: owned }
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
      responses:
        "200":
          description: The matched documents
          content:
            application/json:
              schema:
                type: object
                properties:
                  docs:
                    type: array
                    items: { $ref: "#/components/schemas/DocListItem" }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}:
    parameters:
      - $ref: "#/components/parameters/Slug"
    get:
      tags: [docs]
      summary: Fetch a document (metadata + html)
      operationId: getDoc
      responses:
        "200":
          description: |
            Owner sees view_token; a grantee sees role instead of view_token.
          content: { application/json: { schema: { $ref: "#/components/schemas/DocWithHtml" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
    patch:
      tags: [docs]
      summary: Update html (full rewrite), title, or visibility
      description: |
        Owner or editor grant may rewrite html. Only the owner may change
        title or public (visibility).
      operationId: updateDoc
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              properties:
                html: { type: string, maxLength: 2097152 }
                title:
                  type: [string, "null"]
                  maxLength: 300
                public: { type: boolean }
      responses:
        "200":
          description: Updated
          content: { application/json: { schema: { $ref: "#/components/schemas/DocWithHtml" } } }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { description: Editor tried to change title/visibility, content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } } }
        "404": { $ref: "#/components/responses/NotFound" }
        "413": { $ref: "#/components/responses/TooLarge" }
        "429": { $ref: "#/components/responses/RateLimited" }
    delete:
      tags: [docs]
      summary: Soft-delete a document (owner only)
      operationId: deleteDoc
      responses:
        "200":
          description: Deleted
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  deleted: { type: boolean }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/edits:
    parameters:
      - $ref: "#/components/parameters/Slug"
    post:
      tags: [docs]
      summary: Apply deterministic patches
      description: |
        exact-match-then-fuzzy edit application. Owner or editor grant. Always
        send base_version; a mismatch returns 409. Ambiguous, no-match, or
        overlapping edits return 422 naming the failing edit index.
      operationId: editDoc
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [edits]
              properties:
                edits:
                  type: array
                  minItems: 1
                  maxItems: 200
                  items:
                    type: object
                    required: [oldText, newText]
                    properties:
                      oldText: { type: string }
                      newText: { type: string }
                base_version: { type: integer, minimum: 1 }
      responses:
        "200":
          description: Patched
          content: { application/json: { schema: { $ref: "#/components/schemas/DocWithHtml" } } }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: base_version conflict
          content: { application/json: { schema: { $ref: "#/components/schemas/VersionConflict" } } }
        "413": { $ref: "#/components/responses/TooLarge" }
        "422":
          description: An edit could not be applied deterministically
          content: { application/json: { schema: { $ref: "#/components/schemas/EditFailed" } } }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/rotate-token:
    parameters:
      - $ref: "#/components/parameters/Slug"
    post:
      tags: [docs]
      summary: Rotate the view token (un-share; owner only)
      operationId: rotateViewToken
      responses:
        "200":
          description: New view token issued
          content: { application/json: { schema: { $ref: "#/components/schemas/OwnerDoc" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/versions:
    parameters:
      - $ref: "#/components/parameters/Slug"
    get:
      tags: [docs]
      summary: List retained version history (newest first)
      operationId: listVersions
      responses:
        "200":
          description: Version metadata (no html)
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  current_version: { type: integer }
                  versions:
                    type: array
                    items: { $ref: "#/components/schemas/VersionMeta" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/versions/{n}:
    parameters:
      - $ref: "#/components/parameters/Slug"
      - name: n
        in: path
        required: true
        schema: { type: integer, minimum: 1 }
    get:
      tags: [docs]
      summary: Fetch a specific version's full html
      operationId: getVersion
      responses:
        "200":
          description: Version snapshot with html
          content:
            application/json:
              schema:
                allOf:
                  - { $ref: "#/components/schemas/VersionMeta" }
                  - type: object
                    properties:
                      slug: { type: string }
                      html: { type: string }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/grants:
    parameters:
      - $ref: "#/components/parameters/Slug"
    get:
      tags: [sharing]
      summary: List grants (owner only)
      operationId: listGrants
      responses:
        "200":
          description: Grants on the document
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  grants:
                    type: array
                    items: { $ref: "#/components/schemas/Grant" }
                  count: { type: integer }
                  max: { type: integer }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
    post:
      tags: [sharing]
      summary: Share with an email or a domain (owner only)
      description: |
        Provide exactly one of email or domain. role is editor, commenter, or
        viewer. Consumer email providers (gmail.com, ...) are rejected with 422.
        Re-granting the same target+role is idempotent (200 with unchanged:true).

        Email grants send the grantee a share-notification email containing ONE
        link: a single-use, 7-day login token with next=/d/:slug. Clicking it
        logs the grantee in (email-keyed session, no account needed) and lands
        them on the document; the email also explains how to register an agent
        via auth.md to edit. Set notify:false to suppress the email. DOMAIN
        grants NEVER notify (we don't email a whole company); notify is ignored
        for them. Notification sends count against the per-recipient email caps;
        a send failure or rate-limit never fails the grant (it is already
        committed, and the /d/:slug "was this shared with you? sign in" fallback
        recovers a missed/expired link).
      operationId: createGrant
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [role]
              oneOf:
                - required: [email]
                - required: [domain]
              properties:
                email: { type: string, format: email }
                domain: { type: string, example: kernel.sh }
                role: { type: string, enum: [editor, commenter, viewer] }
                notify:
                  type: boolean
                  default: true
                  description: |
                    Email-grants only. Send the grantee a share-notification
                    email (default true). Ignored for domain grants.
      responses:
        "201":
          description: Grant created
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  grant: { $ref: "#/components/schemas/Grant" }
                  notified:
                    type: boolean
                    description: |
                      Present only for email grants: true if the
                      share-notification email was sent, false if suppressed
                      (notify:false) or skipped (rate-limited / send failed).
        "200":
          description: Idempotent re-grant (same target + role)
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  grant: { $ref: "#/components/schemas/Grant" }
                  unchanged: { type: boolean }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Quota" }
        "404": { $ref: "#/components/responses/NotFound" }
        "422":
          description: Consumer email domain rejected
          content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/grants/{id}:
    parameters:
      - $ref: "#/components/parameters/Slug"
      - name: id
        in: path
        required: true
        schema: { type: integer, minimum: 1 }
    delete:
      tags: [sharing]
      summary: Revoke a grant (owner only)
      operationId: deleteGrant
      responses:
        "200":
          description: Grant revoked
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  grant_id: { type: integer }
                  deleted: { type: boolean }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
components:
  securitySchemes:
    bearerApiKey:
      type: http
      scheme: bearer
      bearerFormat: jh_live_...
      description: |
        Long-lived API key obtained via the auth.md service_auth flow. Carries
        scopes docs.read docs.write. 401s include a WWW-Authenticate header
        pointing at the protected-resource metadata.
  parameters:
    Slug:
      name: slug
      in: path
      required: true
      schema: { type: string, example: fierce-tiger-12345 }
  schemas:
    OwnerDoc:
      type: object
      description: Document as seen by its owner (includes view_token).
      properties:
        slug: { type: string }
        url: { type: string, format: uri }
        title: { type: [string, "null"] }
        version: { type: integer }
        public: { type: boolean }
        view_token: { type: string }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
        html: { type: string }
    DocListItem:
      type: object
      description: |
        A document as returned by GET /api/v1/docs (any scope). Carries access
        (owner|editor|commenter|viewer). Owned items (access=owner) additionally
        carry view_token; shared items omit it.
      required: [slug, url, title, access, version, public, created_at, updated_at]
      properties:
        slug: { type: string }
        url: { type: string, format: uri }
        title: { type: [string, "null"] }
        access:
          type: string
          enum: [owner, editor, commenter, viewer]
          description: |
            The caller's access to this doc. owner for docs you own; otherwise
            the resolved grant role (an explicit email grant beats a domain
            grant for the same email).
        version: { type: integer }
        public: { type: boolean }
        view_token:
          type: string
          description: Present only when access=owner.
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
    DocWithHtml:
      type: object
      description: |
        Owner sees view_token; a grantee sees role (editor/commenter/viewer)
        instead. html is included on single-doc fetches and after writes.
      properties:
        slug: { type: string }
        url: { type: string, format: uri }
        title: { type: [string, "null"] }
        version: { type: integer }
        public: { type: boolean }
        view_token: { type: string }
        role: { type: string, enum: [editor, commenter, viewer] }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
        html: { type: string }
    VersionMeta:
      type: object
      properties:
        version: { type: integer }
        edit_kind: { type: string, enum: [create, patch, rewrite] }
        author_user_id:
          type: [integer, "null"]
          description: User who authored this version (null for legacy/system writes).
        patch:
          type: array
          description: >-
            The edits payload as requested, present only when edit_kind=patch
            (the list of {oldText,newText} applied). Omitted otherwise.
          items:
            type: object
            required: [oldText, newText]
            properties:
              oldText: { type: string }
              newText: { type: string }
        bytes: { type: integer }
        created_at: { type: string, format: date-time }
    Grant:
      type: object
      properties:
        id: { type: integer }
        grantee_type: { type: string, enum: [email, domain] }
        grantee: { type: string }
        role: { type: string, enum: [editor, commenter, viewer] }
        created_at: { type: string, format: date-time }
    ApiError:
      type: object
      required: [error, message]
      properties:
        error: { type: string }
        message: { type: string }
    AgentError:
      type: object
      required: [error, message]
      properties:
        error: { type: string }
        message: { type: string }
    OAuthError:
      type: object
      required: [error]
      properties:
        error: { type: string }
        error_description: { type: string }
    VersionConflict:
      type: object
      properties:
        error: { type: string, enum: [version_conflict] }
        message: { type: string }
        current_version: { type: integer }
        versions_url: { type: string }
    EditFailed:
      type: object
      properties:
        error: { type: string, enum: [edit_failed] }
        message: { type: string }
        reason: { type: string }
        edit_index: { type: integer }
        other_edit_index: { type: integer }
        occurrences: { type: integer }
  responses:
    Unauthorized:
      description: Missing/invalid credential
      headers:
        WWW-Authenticate:
          schema: { type: string }
          description: 'Bearer resource_metadata="https://justhtml.sh/.well-known/oauth-protected-resource"'
      content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
    NotFound:
      description: No such document (also returned for inaccessible docs; no existence oracle)
      content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
    ApiBadRequest:
      description: Invalid request body or parameters
      content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
    TooLarge:
      description: HTML exceeds the 2 MB per-document size limit
      content:
        application/json:
          schema:
            allOf:
              - { $ref: "#/components/schemas/ApiError" }
              - type: object
                properties:
                  limit_bytes: { type: integer }
                  got_bytes: { type: integer }
    Quota:
      description: A resource quota was exceeded (doc count, storage, or grants)
      content:
        application/json:
          schema:
            allOf:
              - { $ref: "#/components/schemas/ApiError" }
              - type: object
                properties:
                  limit: { type: string }
                  limit_value: { type: integer }
                  current: { type: integer }
    RateLimited:
      description: Rate limit exceeded
      headers:
        Retry-After:
          schema: { type: integer }
          description: Seconds until the window resets
      content:
        application/json:
          schema:
            allOf:
              - { $ref: "#/components/schemas/ApiError" }
              - type: object
                properties:
                  retry_after: { type: integer }
security:
  - bearerApiKey: []
`;

export function GET() {
  return new Response(SPEC, {
    status: 200,
    headers: {
      "Content-Type": "application/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
