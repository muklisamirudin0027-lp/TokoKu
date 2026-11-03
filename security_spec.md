# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Identity & Ownership Integrity**: Every document in `/store_profiles/{storeId}`, `/catalog_products/{productId}`, `/pos_transactions/{transactionId}`, and `/operational_expenses/{expenseId}` must belong to a verified authenticated user (`request.auth != null && request.auth.token.email_verified == true`) where `ownerUid == request.auth.uid`, or be accessed by a verified bootstrapped administrator (`muklisamirudin0027@gmail.com` with `email_verified == true` or present in `/admins/{uid}`).
2. **Path Variable Hardening**: Every single-document ID (`storeId`, `productId`, `transactionId`, `expenseId`, `adminId`) must satisfy `isValidId(id)` (`id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\-]+$')`).
3. **Strict Key Allowlisting (`hasAll` & `hasOnly`)**: Every create and update operation must validate exact required keys (`hasAll`) and allowed keys (`hasOnly`) via its standalone `isValid[Entity](incoming())` blueprint helper to block shadow/ghost fields.
4. **Temporal Integrity**: `createdAt` must equal `request.time` on creation and remain strictly immutable (`incoming().createdAt == existing().createdAt`) on update. `updatedAt` must equal `request.time` on both creation and update.
5. **Terminal State Locking**: Once a `PosTransaction` reaches terminal status `status == 'dibatalkan'` (voided), further updates are rejected unless performed by `isAdmin()`.
6. **Zero-Trust Query Enforcement**: Every `allow list` rule enforces `resource.data.ownerUid == request.auth.uid || isAdmin()` without delegating security to client queries or invoking `get()`/`exists()` inside `list`.

---

## 2. The "Dirty Dozen" Payloads (Adversarial Test Vectors)
1. **Payload 1 (Shadow Field Injection)**: `StoreProfile` create payload containing an undeclared field `"isVerifiedAdmin": true` -> **PERMISSION_DENIED**.
2. **Payload 2 (Identity Spoofing on Create)**: `CatalogProduct` create payload where `ownerUid` is set to another user's UID (`"victim_uid_123"`) -> **PERMISSION_DENIED**.
3. **Payload 3 (Unverified Email Spoofing)**: Request where `request.auth.token.email == 'muklisamirudin0027@gmail.com'` but `request.auth.token.email_verified == false` -> **PERMISSION_DENIED**.
4. **Payload 4 (Path ID Poisoning)**: Document ID containing 200 characters or special characters (`"prod/../../hack"`) -> **PERMISSION_DENIED**.
5. **Payload 5 (Forged Client Timestamp on Create)**: `OperationalExpense` create payload with a past/future `createdAt` timestamp not equal to `request.time` -> **PERMISSION_DENIED**.
6. **Payload 6 (Mutating Immortal Field `createdAt` on Update)**: `CatalogProduct` update payload modifying `createdAt` -> **PERMISSION_DENIED**.
7. **Payload 7 (Mutating `ownerUid` on Update)**: `StoreProfile` update payload attempting to transfer ownership (`incoming().ownerUid != existing().ownerUid`) -> **PERMISSION_DENIED**.
8. **Payload 8 (Terminal State Bypass on Voided Transaction)**: `PosTransaction` update attempting to change a transaction whose existing `status` is `'dibatalkan'` back to `'selesai'` -> **PERMISSION_DENIED**.
9. **Payload 9 (Value Poisoning on Whitelisted Key)**: `CatalogProduct` update setting `sellingPrice` to a string `"gratis"` or negative number `-5000` -> **PERMISSION_DENIED**.
10. **Payload 10 (Denial-of-Wallet Oversized String)**: `OperationalExpense` payload with a `title` exceeding `200` characters -> **PERMISSION_DENIED**.
11. **Payload 11 (Unauthorized Cross-Tenant List Scraping)**: Authenticated non-admin user executing a `list` query on `/pos_transactions` without filtering `ownerUid == request.auth.uid` -> **PERMISSION_DENIED**.
12. **Payload 12 (Self-Assigned Admin Creation)**: Regular user attempting to create a document in `/admins/{uid}` -> **PERMISSION_DENIED**.

---

## 3. Test Runner Verification
Implemented in `/src/utils/firestoreRules.test.ts` and executed via `./node_modules/.bin/tsx --test src/utils/*.test.ts` to verify all 12 adversarial payloads and schema constraints.
