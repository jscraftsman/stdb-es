## 0.4.2 (2026-11-23)

### Refactor

- **Examples**: Phase 3: Move the files from "examples\set\counter-with-frontend" to "examples\react-counter"
- **Examples**: Phase 2: Remove the basic "examples/counter"

## 0.4.1 (2026-11-22)

### Refactor

- **Cleanup**: Phase 5: Cleanup of docs after applying new write boundary - updated examples
- **Cleanup**: Phase 4: Cleanup of docs after applying new write boundary - updated items related to integration testing kit
- **Cleanup**: Phase 3: Cleanup of docs after applying new write boundary - updated items related to unit testing kit
- **Cleanup**: Phase 2: Cleanup of docs after applying new write boundary - updated core source code and docs

## 0.4.0 (2026-11-21)

### BREAKING CHANGE

- New write boundary approach. Frontend SDK no longer has direct access to appending events and will instead just send commands to the backend

### Feat

- **WriteBoundary**: Phase 6: Document updates for new write boundary approach. New requirements implemented
- **WriteBoundary**: Phase 2: Updated core source code to prefer command in frontend instead of exposing the event store append

### Refactor

- **WriteBoundary**: Phase 5: Updated examples to use new write boundary approach
- **WriteBoundary**: Phase 4: Updated integration testing kit to use new write boundary approach
- **WriteBoundary**: Phase 3: Updated unit testing kit to use new write boundary approach

## 0.3.0 (2026-11-19)

### Feat

- **IntegrationTestKit**: Completed M7, added integration testing kit and updated documentation

### Fix

- **IntegrationTest**: Attempt 1 to fix pipeline issue for integration testing

## 0.2.0 (2026-11-18)

### Feat

- **UnitTestsTools**: Completed M6 - Unit testing kit and added unit testing guide

## 0.1.1 (2026-11-18)

### Refactor

- **CI**: Attempt 1 to add cz bump automation

## 0.1.0 (2026-11-18)

### Feat

- **SubscriptionBridge**: Completed M5
- **ExampleSet**: Added "counter with frontend" example set
- implement stdb-es event store
