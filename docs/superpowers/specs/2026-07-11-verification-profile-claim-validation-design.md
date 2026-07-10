# NSS-EviMem Verification Profile 与 Claim Validation 分层设计

日期：2026-07-11

状态：已确认的实现规格

## 1. 目标

把当前依赖 `case_id` 的 artifact claim 校验改造成可复用的任务类型校验机制，同时保持 NSS-EviMem 的插件边界：

- Task Contract 由 Agent 从用户自然语言中生成，并声明本任务采用哪一类公开校验规则；
- 插件验证该 Contract 是否完整、是否选择了兼容的 `verification_profile`；
- Claim Validator 使用 profile 检查 artifact 是否具备支撑某一级 claim 的资格；
- benchmark hidden oracle 只在离线 evaluator 中判断答案是否正确，不进入插件、prompt、EvidenceMemory 或 profile；
- 插件通过不等于 benchmark 答案正确，插件失败则表示当前 artifact 不足以支撑 verified claim。

本次首先覆盖 `CBSC-V2-NL-X01` 所属的 differential metric 任务，并保留现有 SIMON32/64 differential-linear 校验能力。

## 2. 已比较方案

### 方案 A：继续按 `case_id` 编写规则

每道 benchmark 单独实现 checker。优点是开发快、能精确命中案例；缺点是规则数量随题目线性增长，容易把 benchmark 答案泄露到插件，也无法说明插件具备跨任务泛化能力。

### 方案 B：Agent 在 Task Contract 中自由编写全部校验规则

插件只执行 Agent 给出的规则。优点是灵活；缺点是 Agent 可以因理解错误或为通过校验而弱化规则，形成“自己出题、自己评分”的闭环，不能作为可信门控。

### 方案 C：Task Contract 选择插件内置、带版本的任务类型 profile

Agent 负责选择 profile 和描述任务边界，插件拥有不可被 Agent 削弱的 profile 注册表。公开算法约束和证据要求进入 profile，具体答案仍留在 hidden oracle。该方案兼顾复用、可审计和 benchmark 隔离，因此采用方案 C。

## 3. 三层职责

### 3.1 Task Contract：声明“要验证什么”

Agent 继续负责自然语言理解。Task Contract 新增：

```json
{
  "case_id": "CBSC-V2-NL-X01",
  "domain": "symmetric_cryptanalysis",
  "cipher": "SIMON32",
  "rounds": 10,
  "analysis_type": "differential",
  "metric": "minimum_differential_weight_or_max_probability",
  "objective": "reproduce_exact_metric_or_honest_bound",
  "verification_profile": {
    "id": "differential_metric_v1",
    "primitive_profile": "simon_family_v1",
    "claim_mode": "exact_or_honest_bound"
  }
}
```

Contract 只能选择 profile 和 claim mode，不能关闭 profile 的强制检查。后续允许加入只会收紧规则的约束，但不允许覆盖或降低内置规则的严重级别。

`nss_evimem_validate_contract` 增加以下验证：

- profile id 必须存在且版本受支持；
- profile 的 domain、analysis type 和 metric 必须与 Contract 兼容；
- primitive profile 必须与 cipher family 兼容；
- `claim_mode` 必须属于 profile 支持的模式；
- 未声明 profile 的旧 Contract 继续执行 generic checks，以保持兼容；
- 声明未知或不兼容 profile 的 Contract 返回 `unsupported_contract` 或 `invalid_contract`。

### 3.2 Claim Validator：检查“证据是否足够”

`nss_evimem_validate_artifact_claims` 解析 Task Contract 中的 profile，从注册表加载检查器。它不读取 hidden oracle，也不根据 case id 查找正确数值。

返回结果新增：

```json
{
  "schema": "nss_evimem.artifact_claim_validation.v2",
  "verification_profile": {
    "id": "differential_metric_v1",
    "primitive_profile": "simon_family_v1",
    "version": 1
  },
  "verification_scope": "evidence_eligibility_not_oracle_correctness",
  "supports_verified_claim": false,
  "recommended_claim_level": "bounded",
  "failures": ["differential_nontrivial_weight"]
}
```

`recommended_claim_level` 取值：

- `verified`：公开过程规则和证据要求均通过；
- `bounded`：已有可审计结果，但不足以证明 exact/optimal claim；
- `candidate`：仅能作为探索性候选；
- `reject`：结果内部矛盾、任务边界错误或模型明显无效。

这里的 `verified` 仅表示“有资格提出 verified claim”，不表示命中 benchmark 正确答案。为避免误读，结果中固定写入 `verification_scope`。

### 3.3 Benchmark Evaluator：判断“答案是否正确”

实验脚本继续在 Agent 完成后读取 `hidden/oracle.json`。`verified_correct` 必须同时满足：

1. OpenClaw 运行成功；
2. Task Contract 有效；
3. Claim Validator 返回 `supports_verified_claim=true`；
4. 离线 oracle exact match 为 true。

oracle 不进入 Agent workspace，不写入 Task Contract，不参与 profile 解析，也不导入 EvidenceMemory。

## 4. Profile 注册表

新增独立注册表模块，profile 定义与检查逻辑按职责拆分。初始提供三个 profile：

| Profile | 用途 |
|---|---|
| `generic_artifact_consistency_v1` | 现有通用结果/报告一致性和运行时字段检查 |
| `differential_metric_v1` | differential characteristic/probability/weight 类任务的通用规则 |
| `simon_dl_distinguisher_v1` | 迁移现有 SIMON32/64 differential-linear 公开过程规则 |

`simon_family_v1` 是 primitive profile，不包含任何轮数对应的正确 weight。它只保存公开算法不变量和 artifact 解释规则，例如 two-word state、word size 推导、SIMON 旋转常数以及非平凡输入差分约束。

profile 采用显式版本号。规则语义发生不兼容变化时新增版本，不静默修改旧版本。

## 5. `differential_metric_v1` 检查项

### 5.1 任务边界

- `task_boundary_preserved`：artifact 必须能确认 cipher、rounds、analysis type 和 metric；
- `scope_boundary_present`：结论只适用于指定 reduced-round instance，不得宣称 full-cipher break；
- `required_artifacts_readable`：至少有结构化 result 和一份可执行/可审计 source；缺失时不能升级为 verified。

### 5.2 数值与语义

- `differential_nonzero_input`：优化不得使用全零输入差分；
- `differential_nontrivial_weight`：对声明为 exact/optimal 的非平凡 SIMON 多轮结果，`weight=0` 或 `probability=1` 视为模型无效信号；
- `probability_weight_consistency`：若同时给出 weight 与 probability，应满足 `p = 2^-w`（允许数值容差和常见字符串写法）；
- `probability_semantics_declared`：必须区分 single characteristic、differential hull、sampling estimate 或 bound；
- `round_coverage_matches_contract`：trail 或模型声明的轮数必须与 Contract 一致；
- `round_weight_sum_consistency`：存在逐轮 weight 时，其总和必须与最终 weight 一致。

### 5.3 方法与最优性

- `exactness_evidence_present`：`exact`/`optimal` 结论必须有 solver optimality、完整枚举、形式证明或可定位文献复核之一；
- `sampling_not_exact_proof`：随机采样、有限 key/样本实验不能单独证明全局 optimum；
- `method_result_conflict_resolved`：多个方法给出不同 exact weight/probability 时，必须提供结构化冲突解释并将未解决结果降级为 bound/candidate；
- `primitive_model_invariants`：选择 `simon_family_v1` 时，artifact 必须体现正确 word/state 结构和公开 round-function 参数。

检查器优先读取结构化 JSON 字段，再以报告和源码文本作为补充证据。不能可靠解析时不猜测通过；verified claim 降级为 bounded/candidate，并给出缺失字段和 rerun 建议。

## 6. 与当前失败案例的关系

当前 Full Intervention 产物把 10 轮非零差分报告为 `total_weight=0`、`probability=1`。新 profile 会因 `differential_nontrivial_weight` 失败，不能再出现 generic validator `passed`、offline oracle `false` 的矛盾表象。

当前 Contract+Capability 产物同时给出 exhaustive/MILP weight 26 和 literature weight 12，最终直接选 12。新 profile 会要求 `method_result_conflict_resolved`；若没有可审计的来源定位或模型差异解释，只能报告 unresolved bound/candidate。

即使某个产物给出看似合理的 26 并通过所有公开过程检查，offline oracle 仍可判定它不正确。这个差异是分层设计的预期行为，而不是 validator 缺陷。

## 7. 兼容与迁移

- Artifact validation schema 从 v1 升为 v2；保留原有 `status`、`ok`、`supports_verified_claim`、`checks`、`failures`、`warnings` 字段；
- 没有 `verification_profile` 的调用继续执行 generic checks，并返回 `recommended_claim_level=candidate`，不自动获得 verified 资格；
- 现有 SIMON32/64 DL case-aware 规则迁入 `simon_dl_distinguisher_v1`；旧 case id 自动映射仅作为兼容路径，并产生 deprecation warning；
- README、OpenClaw tool description、smoke test 和 NL-X01 四组实验 Contract 同步更新；
- 历史 run 目录保持只读，不重写旧的 v1 评测产物。

## 8. 错误处理与安全边界

- profile 不存在：Contract 不保存为 current，返回明确 reason；
- artifact 路径不存在或 JSON 无法解析：返回结构化失败，不让整个 OpenClaw 会话因未捕获异常退出；
- profile 与 task 不兼容：拒绝验证，避免调用方通过选择较弱 profile 绕过规则；
- Agent 传入自定义 expected answer、oracle value 或降低检查级别的字段：忽略并记录 warning；
- validator 不执行不受信任 artifact，只读取内容；真实工具执行仍由 OpenClaw/外部工具负责。

## 9. 测试与验收

实现采用测试先行，至少覆盖：

1. 已知 profile 的 Contract 有效，未知或不兼容 profile 被拒绝；
2. NL-X01 当前 `weight=0, probability=1` 产物被 `differential_nontrivial_weight` 拒绝；
3. weight 与 probability 不一致时失败；
4. 多方法冲突未解释时不能支持 verified claim；
5. sampling-only 结果不能声称 exact optimum；
6. 一个不包含 oracle 数值、但过程证据完整的合成结果可以通过“证据资格”检查；
7. 无 profile 的旧调用仍可运行，但不会自动获得 verified claim；
8. 现有 SIMON32/64 DL 检查行为保持；
9. NL-X01 离线 evaluator 仍独立读取 hidden oracle，并且最终 `verified_correct` 需要 validator 与 oracle 双重通过；
10. build、typecheck、smoke 和专项验证脚本全部通过。

四组实验重跑后的最低预期不是强行得到正确答案，而是：Full Intervention 对明显错误的 weight 0 结果必须阻断 verified claim；是否达到 `verified_correct` 仍由新一次 Agent 求解质量和 offline oracle 共同决定。

## 10. 非目标

- 不在插件中内置 NL-X01 的 `2^-25` 或 weight 25；
- 不把 Claim Validator 变成 MILP/SAT/SMT 求解器；
- 不保证 Agent 生成的自然语言理解绝对正确；
- 不为每道 benchmark 编写答案匹配规则；
- 不因 validator 通过就把实验标记为 `verified_correct`。
