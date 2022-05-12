const { Toolkit } = require("actions-toolkit");
const ZenHub = require("zenhub-api");

// g1 is the keyword | g2 is issue number without #
const ISSUE_KW =
  /(?:^|(?<= |\t|,|\.|;|"|'|`))(close|closes|closed|fixed|fix|fixes|resolve|resolves|resolved)\s+#(\d+)/gim;

Toolkit.run(async (tools) => {
  const bodyList = [];
  const zhApiKey = tools.inputs.zhapikey;
  const zhPipelineName = tools.inputs.zhpipelinename;
  const zhActionBranch = tools.inputs.zhactionbranch;
  const requiresIssue = tools.inputs.requireissue === "true";
  var owner = tools.context.repo.owner;
  var repo = tools.context.repo.repo;

  tools.log.info(
    `context issue: ${JSON.stringify(tools.context.issue, null, 2)}`
  );
  tools.log.info(
    `context pull: ${JSON.stringify(tools.context.pull, null, 2)}`
  );
  tools.log.info(`context: ${JSON.stringify(tools.context, null, 2)}`);

  const { data: pr } = await tools.github.pulls.get({
    ...tools.context.pull,
  });

  tools.log.info(`pr: ${JSON.stringify(tools.context.pull, null, 2)}`);

  if (pr.body) {
    bodyList.push(pr.body);
    tools.log.info(`found pull body: ${pr.body}`);
  }

  const { data: comments } = await tools.github.pulls.listReviewComments({
    owner: owner,
    repo: repo,
    pull_number: pr.number,
  });

  const { data: commits } = await tools.github.pulls.listCommits({
    owner: owner,
    repo: repo,
    pull_number: pr.number,
  });

  tools.log.info(
    `found review ${comments.length} comments to scan on the pull`
  );

  for (let comment of comments) {
    bodyList.push(comment.body);
  }

  for (let commit of commits) {
    tools.log.info(`commit: ${JSON.stringify(commit, null, 2)}`);
    bodyList.push(commit.commit.message);
  }

  var issueIds = [];
  for (let body of bodyList) {
    var matches = [...body.matchAll(ISSUE_KW)];
    for (let item of matches) {
      if (item.length >= 3 && item[2].length > 0) {
        issueIds.push(item[2]);
      }
    }
  }

  // unique
  const unique = [...new Set(issueIds)];
  tools.log.info(`found linked issues: ${JSON.stringify(unique)}`);

  if (unique.length <= 0) {
    if (requiresIssue === true) {
      tools.exit.failure(
        "requireissue is set to true, and no issues were found. Please edit the pull request message to contain a fix reference."
      );
      return;
    } else {
      tools.exit.neutral(
        `no linked issues found for the pull request: ${pr.number}`
      );
    }
  }

  var numAttemptMoved = 0;
  var numMoved = 0;

  if (
    tools.context.ref.endsWith(zhActionBranch) &&
    tools.context.event === "push"
  ) {
    tools.log.info(`found a push event on selected branch - moving issues`);

    for (let iid of unique) {
      // connect to ZH
      const api = new ZenHub(zhApiKey);

      // get the board to locate the pipeline by name
      var board = null;
      api
        .getBoard({ repo_id: tools.context.payload.repository?.id })
        .then((data) => {
          board = data;
        })
        .catch((e) => {
          tools.exit.failure(`unable to retreive zenhub board for repo: ${e}`);
        });

      // todo: remove
      tools.log.info(`repo id: ${tools.context.payload.repository?.id}`);
      tools.log.info(`board: ${JSON.stringify(board, null, 2)}`);

      if (board) {
        var targetPipelineId = null;
        for (let p of board.pipelines) {
          if (p.name == zhPipelineName) {
            targetPipelineId = p.id;
            break;
          }
        }

        if (targetPipelineId) {
          // move the issue to the pipeline
          var cpAction = null;
          api
            .changePipeline({
              repo_id: tools.context.payload.repository?.id,
              issue_number: iid,
              body: {
                pipeline_id: targetPipelineId,
                position: "top",
              },
            })
            .then((data) => {
              cpAction = data;
            })
            .catch((e) => {
              tools.log.error(
                `setting issue #${iid} column to ${zhPipelineName} failed: ${e}`
              );
            });

          // todo: remove
          tools.log.info(
            `change pipeline result: ${JSON.stringify(cpAction, null, 2)}`
          );

          numAttemptMoved += 1;
          if (cpAction == 200) {
            numMoved += 1;
            tools.log.info(
              `setting issue #${iid} column to ${zhPipelineName} success`
            );
          } else {
            tools.log.info(
              `setting issue #${iid} column to ${zhPipelineName} failed: ${cpAction}`
            );
          }
        } else {
          tools.log.info(
            `unable to locate a zenhub pipeline named '${zhPipelineName}'`
          );
        }
      } else {
        tools.log.info(
          `unable to locate a zenhub board for repo: '${repo}' (${tools.context.payload.repository?.id})`
        );
      }
    }
  }
  tools.exit.success(
    `succesfully moved ${numMoved}/${numAttemptMoved} issues to ${zhPipelineName}`
  );
});
