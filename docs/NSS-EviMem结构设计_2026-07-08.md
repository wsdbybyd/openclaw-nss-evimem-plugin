# NSS-EviMem 结构设计更新版

日期：2026-07-08

## 1. 本版更新目的

本版是在原《NSS-EviMem结构设计_最终版》的基础上，结合 `CBSC-V2-HARD-SIMON32-DL-SEARCH-002` 的真实 OpenClaw 实验结果补充而来。原设计已经包含 Task Contract、Tool Capability、Evidence、Claim-Evidence Binding、Failure Diagnosis、Rollback/Rerun 等机制。本版重点补上一个实验暴露出的缺口：

> 插件不仅要记录“工具运行过”和“报告没有 overclaim”，还要在最终 claim 前检查 artifact 是否具备支撑 verified cryptanalysis claim 的资格。

这个补充仍然属于插件层，不把 NSS-EviMem 变成真实密码分析求解器。插件不负责发现正确 distinguisher，只负责判断当前 artifact 是否足以支撑 Agent 写出的 claim。

## 2. 更新后的分层职责

```text
User Query
  -> Task Contract
  -> Tool Capability / Guard
  -> Tool Execution
  -> Evidence / Artifact
  -> Artifact Claim Validation
  -> Failure Diagnosis / Intervention
  -> Final Claim / Memory
```

### Layer 5：Task Contract

自然语言理解仍由 Agent 完成。插件检查结构化 Task Contract 是否完整、语义一致，并可要求它包含更细的任务约束，例如：

- cipher、rounds、analysis_type、method、scope；
- required_artifacts；
- expected_state_representation；
- required_measurement；
- required_decompositions；
- claim_type。

### Layer 3：Tool Capability Registry

工具能力不再只声明“我能做 Simon32/64 DL search”，而应声明可验证能力边界：

- 是否支持完整 two-word 32-bit state；
- 是否实现真实 round key 加法；
- 是否输出 signed_sum、sample budget、noise floor；
- 是否枚举或比较指定 split；
- 支持 verified claim 还是 candidate claim。

### Layer 4：Artifact Claim Validation

新增 `nss_evimem_validate_artifact_claims`。它位于最终报告前，检查 result JSON、源码、运行日志和 final report 是否能支撑 verified claim。

它不泄露 hidden oracle，也不替代密码分析工具。它只做资格校验：

- artifact 是否存在且可读；
- result JSON 是否自洽；
- final claim 是否和 artifact 一致；
- 源码是否体现任务所需的关键建模条件；
- case-aware 规则是否满足。

## 3. SIMON32/64 DL Case-Aware 校验规则

针对 `CBSC-V2-HARD-SIMON32-DL-SEARCH-002`，本版插件增加以下公开过程约束检查：

| 检查项 | 目的 |
|---|---|
| `simon32_round_function_uses_key` | 检查源码是否体现 round function 中使用 round key |
| `simon32_key_schedule_constant` | 检查 key schedule 是否使用 `c=0xfffc`，并拒绝 `c=3` |
| `simon32_full_state_pair` | 检查结果是否报告完整 32-bit/two-word `Delta_in` 与 `Gamma_out` |
| `simon32_required_decompositions` | 检查是否比较或讨论 `(5,5,4)`、`(5,6,3)`、`(7,3,4)` |
| `dl_signed_sum_measurement` | 检查是否使用 signed-sum 或等价 DL correlation 公式 |
| `result_claim_consistency` | 检查 `distinguishable=true` 与 `no verified distinguisher` 这类自相矛盾 |
| `runtime_duration_sane` | 检查 `total_time_s` 是否像 elapsed seconds，而不是时间戳 |

这些规则不要求 artifact 命中 hidden oracle pair。它们只判断 artifact 是否具备进入 verified claim 的基本资格。

## 4. 与原设计的关系

原设计中已有：

- Task Contract 可校验；
- 工具语义匹配；
- artifact 可回放；
- claim 必须绑定 evidence；
- 错误 evidence 不能支撑最终报告；
- 失败后可以 rerun/intervention。

本版新增的是把 “artifact validation / claim verifier” 从通用框架细化为可执行插件工具，并为当前 SIMON32/64 benchmark 加入 case-aware 检查规则。

因此，本版不是推翻原设计，而是把原设计中的 Layer 4 和跨层 verifier 具体落地。

## 5. 实验解释边界

当前实验结论应表述为：

> NSS-EviMem 插件能够让失败轨迹更可诊断、可回放、可干预，并能阻止不合格 artifact 支撑 verified claim。它尚不证明插件能直接产出正确密码分析答案。

新增 artifact checker 后，如果 Agent 再生成缺 key schedule、单 16-bit 状态、未比较 split 或报告自相矛盾的结果，插件应返回 `supports_verified_claim=false`，后续 intervention 应要求 bounded rerun 或降级为 bounded failure。

当前实现中，`nss_evimem_diagnose_failure` 会读取 `artifact_claim_validation.json`。如果 checker 返回失败，诊断结果会加入 `artifact_claim_invalid`，并在 rerun plan 中要求再次调用 artifact checker 后才能提升为 verified claim。

## 6. 后续可扩展方向

1. 为更多 benchmark 增加 case-aware checker。
2. 将 Tool Capability Registry 扩展为可声明 state representation、measurement、decomposition coverage。
3. 在真实 OpenClaw 实验中加入 “checker-gated final answer” 组，观察是否能进一步减少 unsupported verified claim。
