# Security Specification

## 1. Data Invariants

1. **User Accounts**: A user's properties (`name`, `studiedCount`) are self-contained. The `studiedCount` can only be incremented or modified by the user who owns the record, enforcing that `request.auth.uid == userId`.
2. **Decks**: A set of flashcards (`Deck`) must belong exclusively to a user who created them (`userId`). The application strictly enforces `userId` matches the current logged-in user at the time of creation.
3. **Temporal Consistency**: On both User and Deck creation/updates, the `updatedAt` value must be strictly verified against the system's `request.time`. `createdAt` is immortal and cannot change after the initial document creation. 

## 2. Dirty Dozen Payloads

1. **Privilege Escalation**: Attempting to set `userId` in a deck to another user's UID.
2. **Missing Author Identity**: A creating a deck without the `userId` field.
3. **Unauthorized Modification**: A user trying to update a deck they don't own.
4. **Invalid Type Insertion**: Injecting a 1MB string to the `studiedCount` field.
5. **Unauthorized Property Access**: Updating `studiedCount` of a user to a negative number.
6. **Data Type Mismatch**: Creating a string where string list is expected.
7. **Size Limits Exceeded**: Pushing list elements beyond `100` elements limit for `cards`.
8. **Temporal Attack**: Sending a custom string logic as `updatedAt`.
9. **Shadow Data**: Writing unspecified properties like `isAdmin` to the user profile.
10. **Orphan Relational Entity**: Faking `request.auth.uid` validation.
11. **Id Poisoning**: Using path `/users/SOME_LONG_FAKE_STRING`.
12. **Null Bypass**: Null payload for read/write requests.

## 3. Test Runner 

A robust structure (hypothetical TS script) verifies that ALL rules strictly evaluate requests with correct conditions and denies all permutations from the 'Dirty Dozen' test patterns.
