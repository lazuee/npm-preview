import https from "https";

const GITHUB_REGEX = /github\.com\/(?<repo>[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)(?=\.git|\/|$)(?:\.git)?(?:\/(?<type>tree|commit|pull)(?:\/(?<ref>[a-zA-Z0-9_.-]+))?(?:\/files)?)?/;

export async function getGitRef(repoUrl) {
  const match = repoUrl.match(GITHUB_REGEX);
  if (!match?.groups) throw new Error("Invalid GitHub URL format");

  const { repo, type, ref } = match.groups;

  if (type === "pull") {
    const { headRepo, headRef } = await fetchPRInfo(repo, ref);
    return { repo: headRepo, branch: headRef };
  }

  if (type === "commit") {
    return { repo, branch: ref };
  }

  if (type === "tree") {
    return { repo, branch: ref };
  }

  const defaultBranch = await fetchDefaultBranch(repo);
  const latestCommit = await fetchLatestCommit(repo, defaultBranch);
  return { repo, branch: latestCommit };
}

function fetchJSON(path) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    "User-Agent": "nodejs",
    "Accept": "application/vnd.github.v3+json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const options = {
    hostname: "api.github.com",
    path,
    headers,
  };

  return new Promise((resolve, reject) => {
    https.get(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API error: ${res.statusCode} ${res.statusMessage}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse JSON response"));
        }
      });
    }).on("error", reject);
  });
}

async function fetchPRInfo(repo, prNumber) {
  // Fetch pull request data including head repo and ref
  const prData = await fetchJSON(`/repos/${repo}/pulls/${prNumber}`);
  const headRepo = prData.head.repo.full_name;
  const headRef = prData.head.ref;
  return { headRepo, headRef };
}

async function fetchDefaultBranch(repo) {
  const repoData = await fetchJSON(`/repos/${repo}`);
  return repoData.default_branch;
}

async function fetchLatestCommit(repo, branch) {
  const commitData = await fetchJSON(`/repos/${repo}/commits/${branch}`);
  return commitData.sha;
}
