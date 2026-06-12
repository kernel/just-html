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
  - name: collaboration
    description: Comments (W3C text-quote anchors, 1-level threads) and reactions
paths:
  /agent/identity:
    post:
      tags: [auth]
      summary: Start a service_auth registration
      description: |
        Creates a pending registration (no user account is created yet) and
        returns a claim_token plus a claim ceremony block.

        claim_delivery (default "email") selects how the user_code reaches the
        human:
          - "email" (DEFAULT): justhtml.sh emails the login_hint a 6-digit code
            AND a one-click approve link. The user_code is OMITTED from this
            response (the email is the binding proof). The human either clicks
            approve (confirms + signs in) or reads the code back to the agent,
            which submits it to POST /agent/identity/claim/complete.
          - "agent": the spec-pure flow. The response carries user_code +
            verification_uri; the agent surfaces both and the human enters the
            code at the hosted form. Nothing is emailed; there is no
            /agent/identity/claim/complete.
        Modes are mutually exclusive and fixed at registration time. Either way
        the agent polls /oauth2/token for the key.
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
                claim_delivery:
                  type: string
                  enum: [email, agent]
                  default: email
                  description: |
                    email (default): code + approve link emailed; user_code
                    omitted from the response. agent: spec-pure, user_code +
                    verification_uri in the response.
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
                    description: |
                      Email mode (default) omits user_code/verification_uri and
                      carries delivery:"email" + complete_url. Agent mode carries
                      delivery:"agent" + user_code + verification_uri.
                    oneOf:
                      - $ref: "#/components/schemas/ClaimEmailMode"
                      - $ref: "#/components/schemas/ClaimAgentMode"
        "400":
          description: Bad body, bad login_hint, unsupported type, or bad claim_delivery
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AgentError" }
        "429":
          $ref: "#/components/responses/RateLimited"
        "503":
          description: |
            email_send_failed — claim_delivery=email but the email could not be
            sent; the registration is voided. Retry registration.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AgentError" }
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
  /agent/identity/claim/complete:
    post:
      tags: [auth]
      summary: Complete a claim by reading the emailed code back (email mode only)
      description: |
        For claim_delivery=email registrations only. The human reads the 6-digit
        code from the emailed claim message back to the agent, which submits it
        here to confirm the claim WITHOUT a browser session (the binding proof is
        that the code only reached the human via their inbox). Constant-time
        compare; shares the code's 5-attempt budget with the approve link and the
        hosted /claim form. On success the agent's /oauth2/token poll returns the
        key. (Agent-delivery registrations have no read-back: the human enters the
        code at the hosted form — calling this returns 409 wrong_delivery_mode.)
      operationId: completeClaim
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [claim_token, user_code]
              properties:
                claim_token: { type: string }
                user_code: { type: string, example: "428117", pattern: "^[0-9]{6}$" }
      responses:
        "200":
          description: Claim confirmed; poll /oauth2/token for the key
          content:
            application/json:
              schema:
                type: object
                properties:
                  registration_id: { type: string }
                  status: { type: string, example: claimed }
                  message: { type: string }
        "400": { description: Bad body, content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } } }
        "401":
          description: |
            invalid_claim_token (unknown token) or invalid_user_code (wrong code;
            message names attempts remaining).
          content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } }
        "409":
          description: |
            claimed_or_in_flight (already claimed) or wrong_delivery_mode
            (registration uses the hosted form, claim_delivery=agent).
          content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } }
        "410":
          description: |
            claim_expired (registration window closed), code_dead (5 wrong
            attempts), or expired_token (user_code window closed). Re-mint.
          content: { application/json: { schema: { $ref: "#/components/schemas/AgentError" } } }
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
  /api/v1/docs/{slug}/comments:
    parameters:
      - $ref: "#/components/parameters/Slug"
      - name: viewtoken
        in: query
        required: false
        schema: { type: string }
        description: >-
          Present a doc's view token to comment/read as a token-holder (with
          identity). Not needed for owner/grantee sessions or API keys.
    get:
      tags: [collaboration]
      summary: List all comment threads (the complete all-threads view)
      operationId: listComments
      description: |
        Returns every live thread the caller can see, exactly as the viewer
        shell shows humans: anchored threads in document order, then doc-level
        threads, then orphaned threads, each carrying resolved/orphaned flags,
        1-level replies, and reactions. Read access required (owner/grant via
        identity, a valid view token, or a public doc).
      security:
        - bearerApiKey: []
        - {}
      responses:
        "200":
          description: All threads
          content:
            application/json:
              schema:
                type: object
                properties:
                  slug: { type: string }
                  version: { type: integer }
                  total: { type: integer, description: Live comment + reply count. }
                  can_comment: { type: boolean }
                  can_react: { type: boolean }
                  threads:
                    type: array
                    items: { $ref: "#/components/schemas/CommentThread" }
                  doc_reactions:
                    type: array
                    description: Doc-level reactions (present only when any exist).
                    items: { $ref: "#/components/schemas/ReactionGroup" }
        "404": { $ref: "#/components/responses/NotFound" }
    post:
      tags: [collaboration]
      summary: Post a comment (anchored to a quote, doc-level, or a reply)
      operationId: createComment
      description: |
        Comment on a span by QUOTING it (anchor), at the doc level (omit
        anchor), or reply to a root comment (parent_id). Identity required:
        API key OR signed-in session — anonymous never writes. Permission to
        comment: owner, editor or commenter grant, view-token holder with
        identity, or any identity on a public doc.
      security:
        - bearerApiKey: []
        - {}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [body]
              properties:
                body: { type: string, maxLength: 10240, description: "<= 10 KB." }
                anchor:
                  oneOf:
                    - { $ref: "#/components/schemas/TextAnchor" }
                    - { type: "null" }
                  description: W3C text-quote selector; null/omitted = doc-level.
                parent_id:
                  type: [integer, "null"]
                  description: Root comment id to reply to (1-level threads only).
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  comment: { $ref: "#/components/schemas/Comment" }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403":
          description: Can view but not comment (e.g. a viewer-only grant).
        "404": { $ref: "#/components/responses/NotFound" }
        "413": { description: "Comment body exceeds 10 KB." }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/comments/{id}:
    parameters:
      - $ref: "#/components/parameters/Slug"
      - name: id
        in: path
        required: true
        schema: { type: integer, minimum: 1 }
    patch:
      tags: [collaboration]
      summary: Edit body (author) and/or resolve/unresolve (anyone who can comment)
      operationId: updateComment
      security:
        - bearerApiKey: []
        - {}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                body: { type: string, maxLength: 10240, description: "Author only." }
                resolved:
                  type: boolean
                  description: Resolve/unresolve. Anyone who can comment.
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                type: object
                properties:
                  comment: { $ref: "#/components/schemas/Comment" }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { description: "Editing another author's body, or resolving without comment rights." }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
    delete:
      tags: [collaboration]
      summary: Soft-delete a comment (author own, owner any)
      operationId: deleteComment
      security:
        - bearerApiKey: []
        - {}
      responses:
        "200":
          description: Deleted
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer }
                  deleted: { type: boolean }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { description: "Not the author and not the owner." }
        "404": { $ref: "#/components/responses/NotFound" }
  /api/v1/docs/{slug}/reactions:
    parameters:
      - $ref: "#/components/parameters/Slug"
    post:
      tags: [collaboration]
      summary: React to a doc or comment (attributed; re-post toggles off)
      operationId: addReaction
      description: |
        Add an emoji reaction on the doc (omit comment_id) or a comment.
        Attributed-only (identity required); unique per (target, author, emoji)
        — re-posting the same reaction removes it (toggle). React permission:
        anyone who can view, with identity.
      security:
        - bearerApiKey: []
        - {}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [emoji]
              properties:
                emoji: { type: string, description: One of the supported emoji. }
                comment_id:
                  type: [integer, "null"]
                  description: Target comment; omit/null = react on the document.
      responses:
        "201":
          description: Reaction added
          content:
            application/json:
              schema:
                type: object
                properties:
                  reaction:
                    type: object
                    properties:
                      id: { type: integer }
                      comment_id: { type: [integer, "null"] }
                      emoji: { type: string }
                      author: { type: string }
                      created_at: { type: string, format: date-time }
        "200":
          description: Reaction toggled off (the same reaction already existed).
          content:
            application/json:
              schema:
                type: object
                properties:
                  toggled: { type: boolean }
                  removed: { type: boolean }
        "400": { $ref: "#/components/responses/ApiBadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/RateLimited" }
  /api/v1/docs/{slug}/reactions/{id}:
    parameters:
      - $ref: "#/components/parameters/Slug"
      - name: id
        in: path
        required: true
        schema: { type: integer, minimum: 1 }
    delete:
      tags: [collaboration]
      summary: Remove your own reaction
      operationId: deleteReaction
      security:
        - bearerApiKey: []
        - {}
      responses:
        "200":
          description: Removed
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer }
                  deleted: { type: boolean }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
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
    TextAnchor:
      type: object
      description: |
        W3C text-quote selector (TextQuoteSelector + position hint). exact is the
        verbatim quoted passage; prefix/suffix (~32 chars) disambiguate repeated
        text and survive surrounding shifts; start/end are offsets into the
        document's text content (a fast-path hint, not authoritative).
      required: [exact]
      properties:
        type: { type: string, enum: [text] }
        exact: { type: string }
        prefix: { type: string }
        suffix: { type: string }
        start: { type: integer }
        end: { type: integer }
    ReactionGroup:
      type: object
      description: Reactions collapsed by emoji, with the attributed authors.
      properties:
        emoji: { type: string }
        count: { type: integer }
        authors:
          type: array
          items: { type: string, description: Author email. }
    Comment:
      type: object
      properties:
        id: { type: integer }
        parent_id: { type: [integer, "null"] }
        author: { type: [string, "null"], description: Author email. }
        author_avatar: { type: [string, "null"], format: uri, description: Gravatar URL. }
        body: { type: string }
        anchor:
          oneOf:
            - { $ref: "#/components/schemas/TextAnchor" }
            - { type: "null" }
        anchored_version: { type: [integer, "null"] }
        orphaned: { type: boolean, description: "Anchor no longer resolves; kept, shown unanchored." }
        resolved: { type: boolean }
        resolved_at: { type: [string, "null"], format: date-time }
        created_at: { type: string, format: date-time }
        edited_at: { type: [string, "null"], format: date-time }
        reactions:
          type: array
          items: { $ref: "#/components/schemas/ReactionGroup" }
    CommentThread:
      allOf:
        - { $ref: "#/components/schemas/Comment" }
        - type: object
          properties:
            group:
              type: string
              enum: [anchored, doc, orphaned]
              description: Which group this thread sorts into in the all-threads view.
            replies:
              type: array
              items: { $ref: "#/components/schemas/Comment" }
    ApiError:
      type: object
      required: [error, message]
      properties:
        error: { type: string }
        message: { type: string }
    ClaimEmailMode:
      type: object
      description: |
        The claim block in email mode (claim_delivery=email, the default). The
        user_code is intentionally omitted — it was emailed to the human along
        with a one-click approve link. The human clicks approve OR reads the code
        back to the agent for POST /agent/identity/claim/complete.
      properties:
        delivery: { type: string, enum: [email] }
        code_delivery:
          type: string
          description: Human-readable note that the code + approve link were emailed.
        complete_url:
          type: string
          format: uri
          description: POST {claim_token, user_code} here to complete via read-back.
        expires_in: { type: integer, example: 600 }
        interval: { type: integer, example: 5 }
    ClaimAgentMode:
      type: object
      description: |
        The claim block in spec-pure mode (claim_delivery=agent). Carries the
        user_code and verification_uri for the agent to surface to the human.
      properties:
        delivery: { type: string, enum: [agent] }
        user_code: { type: string, example: "428117" }
        verification_uri: { type: string, format: uri }
        expires_in: { type: integer, example: 600 }
        interval: { type: integer, example: 5 }
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
