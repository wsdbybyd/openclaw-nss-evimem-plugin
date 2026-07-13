# NSS-EviMem Agent Repair Feedback Loop

Date: 2026-07-13

## Goal

Allow an OpenClaw Agent to repair a rejected cryptanalysis artifact using
structured NSS-EviMem feedback, without treating the Agent's own revised
claim as independently verified correctness.

## Scope

The plugin will add three connected capabilities.

1. The SIMON differential profile will reject the known invalid AND-difference
   abstraction where an output difference is modeled as the bitwise AND of the
   two input differences. This is a model-semantics failure, not merely a
   missing-evidence failure.
2. A new `nss_evimem_build_repair_feedback` tool will convert failed artifact
   checks and failure diagnosis into a persisted, machine-readable repair
   directive and a prompt patch for the Agent.
3. A new `nss_evimem_assess_repair_attempt` tool will persist repair attempts,
   enforce a bounded retry budget, and require a fresh artifact validation.
   A validation pass ends at `independent_verification_required`; it never
   converts an Agent-authored result into oracle-correctness by itself.

## Data Flow

1. Agent writes result, report, and model source.
2. `nss_evimem_validate_artifact_claims` records failed checks.
3. `nss_evimem_diagnose_failure` records the failure boundary.
4. `nss_evimem_build_repair_feedback` emits direct instructions such as the
   invalid SIMON AND-difference encoding and the required replacement evidence.
5. Agent produces a fresh artifact and calls the validator again.
6. `nss_evimem_assess_repair_attempt` records either another bounded retry,
   report-boundary fallback, or independent-verification-required state.
7. The Full Intervention experiment prompt requires this sequence inside the
   same OpenClaw session whenever its first artifact validation fails.

## Safety Boundary

- The plugin never embeds benchmark answers or reads a hidden oracle.
- The plugin never claims to solve or prove a cryptanalytic optimum.
- An Agent cannot self-certify a repair: a fresh public validation only makes
  the result eligible for a separately configured trusted verifier.
- The implementation records all feedback and attempts under the evidence
  directory for later experiment analysis.

## Tests

- A source containing the known invalid AND-difference encoding fails the
  differential profile with a specific semantic check.
- Repair feedback exposes that failure as a direct corrective instruction.
- A failed repaired artifact consumes retry budget and requests another repair.
- A fresh validation pass requests independent verification instead of claiming
  verified correctness.
- The retry budget produces a report-boundary outcome after its final attempt.
