# ADR-003: Phase 3 domain foundation

## Status
Accepted for Phase 3

## Context
The application schema had a synthetic 36-lesson Topic hierarchy, no explicit Track or Enrollment, and two generations of video/question structures. Phase 2 establishes 23 official lessons under Part → Unit → Lesson.

## Decision
Add Track, Enrollment, and Material as explicit relational entities. Make Lesson's Unit relationship direct and nullable, with stable nullable `officialCode` and a `curriculumStatus` marker. Preserve Topic and existing assessment/video tables as compatibility structures rather than deleting records. Keep Question as the canonical question record and MediaAsset as the storage abstraction.

## Consequences
Existing records remain readable and migration is additive. Official curriculum can be reconciled later without false mappings. The legacy Topic layer is not authoritative and must not receive new official curriculum semantics. A future migration must explicitly map only evidence-backed lessons and archive the rest.
