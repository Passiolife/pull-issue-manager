import { Toolkit } from "actions-toolkit";
import ZenHub from "zenhub-api";

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
  var ignoreZHActionsOnBranch = false;
  
  tools.log.info(`incoming ref: ${tools.context.ref}`);

  if (tools.inputs.zhignorebranches) {
    for (let ib of tools.inputs.zhignorebranches.split(",")) {
      if (tools.context.ref.endsWith(ib)) {
        ignoreZHActionsOnBranch = true;
        tools.log.info(
          `will ignore ZenHub actions on this branch due to ignore setting: ${tools.inputs.zhignorebranches}`
        );
      }
    }
  }

  const { data: pr } = await tools.github.pulls.get({
    owner: owner,
    repo: repo,
    pull_number: tools.context.issue.issue_number,
  });

  if (pr.body) {
    bodyList.push(pr.body);
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
    `found ${comments.length} review comments and ${commits.length} commit messages to scan on the pull`
  );

  for (let comment of comments) {
    bodyList.push(comment.body);
  }

  for (let commit of commits) {
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
        "RequireIssue is set to true, and no issues were found. Please edit the pull request message to contain a fix reference."
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

  tools.log.info(
    `user defined action branch: ${zhActionBranch} / current ref: ${tools.context.ref}`
  );

  if (
    (zhActionBranch === "any" || tools.context.ref.endsWith(zhActionBranch)) &&
    !ignoreZHActionsOnBranch
  ) {
    tools.log.info(`found a push event on selected branch - moving issues`);

    for (let iid of unique) {
      // don't work on closed tickets
      let oIssue = await tools.github.issues.get({
        owner: owner,
        repo: repo,
        issue_number: iid
      });
      if (oIssue && oIssue.data.state === "closed") {
        tools.log.info(`skipping issue #${iid} as it is closed.`);
        continue;
      }
      // connect to ZH
      const api = new ZenHub(zhApiKey);

      // get the board to locate the pipeline by name
      var board = null;
      await api
        .getBoard({ repo_id: tools.context.payload.repository.id })
        .then((data) => {
          board = data;
        })
        .catch((e) => {
          tools.exit.failure(`unable to retreive zenhub board for repo: ${e}`);
        });

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
          await api
            .changePipeline({
              repo_id: tools.context.payload.repository.id,
              issue_number: iid,
              body: {
                pipeline_id: targetPipelineId,
                position: "top",
              },
            })
            .then(() => {
              // this doesnt return anything... so we increase the count of success here:
              numMoved += 1;
            })
            .catch((e) => {
              if (e) {
                tools.log.error(
                  `caught an error when moving issue ${iid} to ${zhPipelineName}: ${e}`
                );
                numMoved -= 1;
              }
            });

          numAttemptMoved += 1;
        } else {
          tools.log.info(
            `unable to locate a zenhub pipeline named '${zhPipelineName}'`
          );
        }
      } else {
        tools.log.info(
          `unable to locate a zenhub board for repo: '${repo}' (${tools.context.payload.repository.id})`
        );
      }
    }
  }
  tools.exit.success(
    `succesfully moved ${numMoved}/${numAttemptMoved} issues to ${zhPipelineName}`
  );
});
