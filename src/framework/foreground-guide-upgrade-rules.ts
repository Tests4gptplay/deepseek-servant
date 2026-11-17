// Exact sentence fingerprints from the shipped/reconstructed Foreground templates.
// These are migration recognizers, not retained obsolete rules or a fallback guide.
// Replacement text is the corresponding CURRENT protocol; no old guide is stored.
// Only these recognized protocol lines are eligible; other user bytes remain untouched.
export const foregroundGuideUpgradeRules = {
  "taskRouting": {
    "prefix": "When submitting work through the P/O task flow, choose and set the initial route yourself in dss_submit_task based on the user's requirements.",
    "starts": [
      "d5e365e511ddb314ff36d9ee47c2f125c3ea5ac0beee1ee868917a0e577a0eb2",
      "9e3f2e3a31343306ea740427499073b36f2e150f794adad4ca060ccd85756ced"
    ],
    "rules": {
      "d5e365e511ddb314ff36d9ee47c2f125c3ea5ac0beee1ee868917a0e577a0eb2": "When submitting work through the P/O task flow, choose and set the initial route yourself in dss_submit_task based on the user's requirements. Do not require the user to label a request as O or P, or ask them to choose a route merely to submit their task. If the user explicitly specifies O or P, follow that choice. Otherwise, choose P for a single objective even when complex, and O for multiple explicit independent objectives that can run in parallel. Complexity, step count and Worker count alone do not select O. Keep short tasks that you can complete directly in Foreground unless the user requests delegation. A P task's Planner decomposes work among Workers.",
      "08f72dad86c2fc00d27d6d71c0082a7f2be468e983a7116143cb349a4ac8dd49": "Organizer assigns individual objectives to Planners or bundles independent objectives for child Organizers.",
      "08dfe240e7d90013af78d3f1aa26d2403cd55b40d6565e7447c8ecabcd0fa767": ""
    }
  },
  "shortTasks": {
    "prefix": "Complete short user tasks yourself in this Foreground execution using the available native tools, within the user's permissions.",
    "starts": [
      "5864ea2025dbfdf1ead97581881a79199f90347663bd2b1282ea76ba0105b7b8",
      "b3b18bdba76870024c6cc79555e051847e2ef15cabc373f21710112be83c5e2f"
    ],
    "rules": {
      "4d9576426b0cb842c132b22380f10c5c4840351427d137801d96add7288eb0e7": "Third-party inputs, including AI submissions, enter the shared Conversation and are handled by this Foreground under the same rules. Existing Direct work and its designated delivery remain unchanged.",
      "5864ea2025dbfdf1ead97581881a79199f90347663bd2b1282ea76ba0105b7b8": "Complete short user tasks yourself in this Foreground execution using the available native tools, within the user's permissions. Publish the result through dss_conversation_send. Do not dispatch a short task to Planner or Worker merely to operate local tools, and do not create a Task tree, Host/runner dependency or background handoff for work you can complete directly. Judge the actual work and user request without a word-count or time threshold. Use the existing P/O task flow when the work calls for it or the user requests that delegation. Third-party inputs, including AI submissions, enter the shared Conversation and are handled by this Foreground under the same rules. Existing Direct work and its designated delivery remain unchanged.",
      "d8a0f92d6fe19803cd4d37ca1222e55cc84018f9e2149d5ce2671f356e686844": ""
    }
  },
  "archive": {
    "prefix": "Keep Foreground_List and Foreground_Cache for important assignments and durable notes.",
    "starts": [
      "6590389a468abf29399b0b48e427e19ea5cc32ba46a0fc8be42ebc74835510cf"
    ],
    "rules": {
      "9c5f1e90a8db4eb6c4731c455254534e310678e0fddfa3fdb1038d1dd69354e9": "records.md is Recorder-authored prose; program-owned mechanical lifecycle/Host/cleanup facts are in current Task metadata runtimeState for Git and archive state.json for Local, not result prose or another retention catalog.",
      "4c27a25487980ed9cd5c3c7af719dcb2569027829707be1676896fc89b6d34e3": "Use the selected Task's current metadata resultPaths and returned archiveRecordsPath and archiveDirectory; if current metadata was removed, use the existing archived Task identity's resultPaths and select that taskId in dss_snapshot for its exact historical archiveDirectory and archiveRecordsPath.",
      "d9f7b931c7710ce304427602951c26e542fd4fc9996fbe7e2a3d85f70132cf97": "Use the selected Task's current metadata resultPaths and returned archiveRecordsPath and archiveDirectory; if current metadata was removed, use the existing archived Task identity's resultPaths and select that taskId in dss_snapshot for its exact historical archiveDirectory and archiveRecordsPath.",
      "32d9ff649513774599c0b1975681bc102e56f44cfa80a2afa74fdeab871e9057": "Task-completion feedback has a required response order: first use the received taskId and supplied taskMetadataPath or context.taskPath (otherwise tasks/<taskId>.json) to read the existing task title in its sourcePath filename and its actual status. If current metadata is absent, read the existing archived Task identity at context.taskHistoryPath when supplied, otherwise archives/task-identities/<taskId>.json, for its sourcePath, status and resultPaths. Use that identity only for historical feedback, never to restart the Task. Then send the task-specific short response; only afterwards inspect results and acceptance details and report them.",
      "9bf6851d88bebcd92cc4cd361b0d25c2a803c471b7689c3fb413a3b58962ed62": "In Git, the current view is fixed; open a fresh view if newer archival metadata is needed. In physical Local, reread the exact archive path to observe its current file."
    }
  },
  "handoff": {
    "prefix": "When the Host wakes you with state signals, consume those exact signals first, before reading the current Git or Local contents.",
    "starts": [
      "446b0fc262d19b8834fb8c7e7456672f9b56114a61b81299b9d403560b0d9209"
    ],
    "rules": {
      "939a31f035b9ec2a17a4859fa7528b60904c4cc75ce34c0abf373300cb6956a8": "Before final handoff, consume and process pending work, then recheck.",
      "927fd55d8764708ec2574bf6a550465351c5073f91b843ef8015b9e8ea82639d": "Git read views remain fixed at their opened revision until release or native turn end. A physical Local view controls lifetime only: each read observes the current addressed file, without a cached snapshot or content/version lock.",
      "e9b2166056b992dbb7350085fa19646b25c57527e939364b8a22799e1129216c": "Writes operate on their actual targets independently.",
      "0ab3b91f2fe62d3a70e493af818fbe1dc875779c416690f46d82ea49849cfca4": "In Git, open another view when newer content is needed; promptly release views you no longer need in either mode."
    }
  },
  "context": {
    "prefix": "Organizer coordinates resource ownership and member/Planner assignments across independent concurrent objectives, users and instances; it does not plan the internal steps of one objective.",
    "starts": [
      "81efbacc791bf058011430caa8a3c3e659f8f9ff0bcd3a6eb6a8942de1f6117d"
    ],
    "rules": {
      "1addc6872c134ce5a10677561e3b33a18d0bec7d4d2c2b396657c13b7ad58fb7": "Use dss_conversation_read mode context (the default) for the latest six complete publication groups plus all current inputs and interim replies. An explicit final send groups the continuous inputs received before its authoritative publication; grouping does not mean all were read or answered and never consumes their signals. responsePhase is hidden metadata, never a prefix or suffix in the original text."
    }
  },
  "reply": {
    "prefix": "When the initial conversation wake needs inspection or other substantive handling, first use dss_conversation_read mode context to consume the supplied wake signals and read the current conversation in one tool call.",
    "starts": [
      "0f5d9235ae1c235f089f3de4d20052244a07eca845ff3c51e32245ece1ab2088",
      "216ebe8a0ce277ca4f948f9f61e7daeeeaa6be1084456b3202ea00d1fc5e0cb2",
      "e8eccfa82725c82b817cfbae9b49d213c9239ccd5281bf095980c8622c11e231"
    ],
    "rules": {
      "0f5d9235ae1c235f089f3de4d20052244a07eca845ff3c51e32245ece1ab2088": "When the initial conversation wake needs inspection or other substantive handling, first use dss_conversation_read mode context to consume the supplied wake signals and read the current conversation in one tool call.",
      "f236c1e8f36c80467003ddbad149da6ef1cb1a5a33ce944c5ccd751961d1724e": "Persist that response immediately with dss_conversation_send using responsePhase \"interim\" when work remains or \"final\" for the final answer, a stable id, intent \"human\" and replyTo set to the actual user message ID.",
      "04b1ac00123f5e51bc70f3b148ef959f4748447e5471f17261b60006fff8a6ea": "Native model text alone is not a user-visible Conversation reply; only dss_conversation_send publishes it.",
      "0724d80c80a84a003237dd056ee1aada9e6c9c14a6b520fb2b67b6aaa5ecf14b": "Publish every user-visible reply, including the final findings, through dss_conversation_send.",
      "7fe9d610b437b814a98f805301420ec66577c9e974ed6d274d45cdfa29db2c7e": "Native final text is not published to Conversation, even when nonempty. After the intended replies have been sent, end the native turn without repeating them.",
      "e8eccfa82725c82b817cfbae9b49d213c9239ccd5281bf095980c8622c11e231": "When the initial conversation wake needs inspection or other substantive handling, first use dss_conversation_read mode context to consume the supplied wake signals and read the current conversation in one tool call.",
      "c1db6bb1f7835803e7ce70ac5117362482fc414b621b66d2befd6a6888c546cb": "Continue the same responsibility after this short response. Publish every user-visible reply, including the final findings, through dss_conversation_send."
    }
  },
  "notifications": {
    "prefix": "Preserve current results before later notifications.",
    "starts": [
      "8133f44e1cf4215f3ab06e8f194977a491311902313cb1964c9b13f84a247c92"
    ],
    "rules": {
      "ab9f80fb2e829cce5eaedcda0f10b3ff9117c618c954dbc8d1c1b42afb54a396": "The Host discovers state signals and wakes an inactive Foreground or notifies the already active Foreground. An online probe or notification only means there is a message; it does not require interrupting your current reading or work rhythm. Decide when to consume later notifications and whether their actual contents affect your current response. Use another ordinary dss_claim when ready to consume the latest top-level state/Foreground_* notifications, then read their actual sources: dss_conversation_read for conversation input, dss_read with the returned snapshotId for authoritative task/report records.",
      "01492af4bdd657b6f436f1a6a0c508eab230f4163cc0cdf47c7d3060dac1f6c3": "Use a fresh dss_snapshot when you need current notifications.",
      "c1e78f15e2062856a8cef8fed1978516534f8a87be6e3725d3173d469a7bc413": "Native inbox delivery and its normal step/status transitions do not consume the authoritative state signals. Before a final user-facing reply, use a fresh dss_snapshot to check for later notifications. If any are present, consume them with the existing claim/read tools, read and process their actual contents, then recheck before publishing the final reply. When none are pending, continue the final reply without another handshake. Interim replies and ongoing work need not be interrupted by a later notification; the Host does not decide the business response or add a publication-time acknowledgement. Only dss_conversation_send publishes replies. The Host does not turn native final text into Conversation messages. Later messages do not replace or withdraw an already published reply.",
      "79f7ed609afddcc468a869e1c48addd6b18e156724ab8aed9d13c81bdd704ae3": "",
      "b754f427ab74ccff6372b4c47e4bc9ff113040c4ce433458ff3506903f823de8": "",
      "0abd2bbba8a470d1f0b8f88e33e615788cba52d68848fa7175889310805736b1": "",
      "850a5ed4594699771f6ff301799b0dc381ec3ca595e30086b064f8bf2674940a": "Unconsumed signals remain available for your later handling or the ordinary wake after this execution ends.",
      "f933bd14ec5dce5571e3c25615fba211ede59c46574073cf63a425330bc0488c": "",
      "f8e9bed0a9cc3f2fb19e238b87a31b3b71f98b68c6424ae9ed11e9c619533d9d": "",
      "dde07b295398d68820cda3117d5bb3b124afdb624da5fae5e0ad7e8b94282b9d": "Before a final user-facing reply, use a fresh dss_snapshot to check for later notifications. If any are present, consume them with the existing claim/read tools, read and process their actual contents, then recheck before publishing the final reply.",
      "09fbac4427777a0fc025079138b654c8b7de757092be7ade9e4d722c3d118d04": "When none are pending, continue the final reply without another handshake. Interim replies and ongoing work need not be interrupted by a later notification; the Host does not decide the business response or add a publication-time acknowledgement."
    }
  },
  "cache": {
    "prefix": "Foreground_Cache is optional for a reply draft.",
    "starts": [
      "50956a1519124b38b848411d7e5187223c76fd4e593f987b72773e4509333839"
    ],
    "rules": {
      "fa75e6645a831ecbc9076e73458f99b7b621d7482932d011c35fc3a8315db2b2": "After the successful send and cleanup, end the native turn; native final text is not another publication path."
    }
  },
  "material-storage": {
    "prefix": "Local DSS logical addresses resolve to physical record files in their configured category roots, separately from the native user-deliverable workspace.",
    "starts": [
      "e47b0d24470c33509c51f8872bbf4978665f9ed89c95194baf059bf56aa16658",
      "96242bc373b319d0c1c42936d57624ad5754cb96bbf31aafd047eae2a9a2aaa0"
    ],
    "rules": {
      "e47b0d24470c33509c51f8872bbf4978665f9ed89c95194baf059bf56aa16658": "Local DSS logical addresses resolve to physical record files in their configured category roots, separately from the native user-deliverable workspace."
    }
  },
  "selected-task-control-path": {
  "prefix": "Use the existing dss_record at the exact taskControlPath returned by dss_snapshot for the selected Task (or sourceLocations.taskControlPath in the Git binding), with that snapshotId, append:false and text containing only the JSON request {\"taskId\":\"<selected taskId>\",\"lifecycleId\":\"<current lifecycleId>\",\"intent\":\"paused\"} or intent \"running\" for resume.",
  "starts": [
    "596523f33c0598948571236532e6e7e0f8abb10e2c2800e14370f15fab84a439",
    "f8f6f353d83bb24458b9884d7db32f9b6f9f8c4b81e62696a454a7adb382fb76"
  ],
  "rules": {
    "596523f33c0598948571236532e6e7e0f8abb10e2c2800e14370f15fab84a439": "Use the existing dss_record at the exact taskControlPath returned by dss_snapshot for the selected Task (or sourceLocations.taskControlPath in the Git binding), with that snapshotId, append:false and text containing only the JSON request {\"taskId\":\"<selected taskId>\",\"lifecycleId\":\"<current lifecycleId>\",\"intent\":\"paused\"} or intent \"running\" for resume."
  }
},
  "local-task-controls": {
  "prefix": "The existing scoped control store persists the same intent and command receipt used by the buttons.",
  "starts": [
    "afa1e850222cdafb0fac1e44007aac3cbd433288ac1e6a6294a3b60843f7b810"
  ],
  "rules": {
    "4ddde106b2abd3056d4c7157153c9123ded14c01ca6a0b74dae613119271b176": "Local Task controls live in task-runs/<taskId>/control.json and are reclaimed with that Task directory; this tool submits the validated request without replacing the file envelope.",
    "629a89c327e518e552125b484bf34ee11f10a4bc1effc8e4f75b35b44e0fb049": "Local Task controls live in task-runs/<taskId>/control.json and are reclaimed with that Task directory; this tool submits the validated request without replacing the file envelope."
  }
},
  "cancellation-publication": {
    "prefix": "Cancellation remains dss_task_cancel, using physical Local publication continuation or the existing Git atomic transaction for Task state and its addressed notifications.",
    "starts": [
      "a3c40097dd02ef90b5bbd30edcf4147c1b7453845403abcb141ca98e450eeb58",
      "1d8eed0b4521036ceff855df05e82c5bc149d6aae9ee9f8a3f970753d1bce2af"
    ],
    "rules": {
      "a3c40097dd02ef90b5bbd30edcf4147c1b7453845403abcb141ca98e450eeb58": "Cancellation remains dss_task_cancel, using physical Local publication continuation or the existing Git atomic transaction for Task state and its addressed notifications."
    }
  },
  "completed-task-restoration": {
    "prefix": "For a report about an unexplained missing Task, offer restoring and continuing the recognizable task or cancelling/cleaning its remaining local state.",
    "starts": [
      "ed8405bb50effa9855d235285d993091b63b6b0468ae213ae0a4af6ec374bb5c"
    ],
    "rules": {
      "a1fe7e654993f5e29a9905ad3e3694906689487cea61efea5037d8f1eadf43b9": "After the user explicitly chooses restoration, check retained Task status: a known completed Task stays complete, and a later correction or new requirement uses a new Task ID referencing its results. Otherwise call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information."
    }
  },
  "cancellation-lifecycle": {
    "prefix": "When the user explicitly asks to cancel a Task, identify the exact existing Task from the conversation and authoritative task records.",
    "starts": [
      "98559e668d177583f1aaa349c8d17130f4be34dbf47a687993398d3641c0150f"
    ],
    "rules": {
      "90147655474a9b479ce15b43592200653e5abd744d3ac455fc783d46e9fa85ce": "Cancellation initiates stopping related business execution.",
      "a67d1f0089e935414080ae4ee890469082ef165205f997053fcf12fdef09552d": "Cancellation initiates stopping related business execution. A cancelled total Task proceeds to Recorder and Cleaner; Recorder preserves current progress, results and unresolved work as cancelled rather than successful completion. A cancelled child Task notifies its linked parent only while that parent is still running, without starting its own Recorder or Cleaner; its temporary materials remain until the total Task is cleaned."
    }
  }
} as const
