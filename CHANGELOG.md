## 0.4.4 (2026-11-27)

### Fix

- **M16**: Phase 2 - Fixed public counter not allowing anonymous users to read and write without requiring user sign-in

### Refactor

- **M16**: Phase 5 - Final consistency check in docs and CI
- **M16**: Phase 4 - Added integration tests for "permissions" example
- **M16**: Phase 3 - Added unit tests for "permissions" example
- **M16**: Phase 2 - Change requirements for frontend setup. Allow multple public read only instances. Applied counter UI themes
- **M16**: Phase 2 - Setup frontend for "permissions" example
- **M16**: Phase 1 - Setup backend module
- **M16**: Phase 0 - Setup new example called "permissions"
- **SpacetimeUpgrade**: STDB v2.16.3, Phase 3 & 4 - Tiered storage policy and final consistency checks
- **SpacetimeUpgrade**: STDB v2.16.3, Phase 2 - Fix subscription error contract and align docs and tests with the SDK's callback
- **SpacetimeUpgrade**: STDB v2.16.3, Phase 1 - Docs and source code comments

## 0.4.3 (2026-11-24)

### Refactor

- **FrontendAgnostic**: Phase 8 - Fixed inconsistencies in all docs after applying the recent changes
- **FrontendAgnostic**: Phase 7 - Update docs based on the recent changes in the examples
- **FrontendAgnostic**: Phase 6 - Added a full stack example using Phaser based from the "react-counter" example
- **FrontendAgnostic**: Phase 5 - Update all docs based on recent change about frontend agnostic requirements
- **FrontendAgnostic**: Phase 4 - "react-counter" example: Keep React as the reference UI with no API drift
- **FrontendAgnostic**: Phase 3 - Source-level note in integration testing kit. Added integration-kit boundary guards. Fixed guard's import parser
- **FrontendAgnostic**: Phase 2 - Made Vitest a required dependency for the unit testing kit
- **FrontendAgnostic**: Phase 1 - Added spec change plan, updated core API and added some initial tests
- **Documentation**: Move out spec changes into a dedicated document

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
