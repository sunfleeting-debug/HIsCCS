package com.bluecome.cmg.services

import com.intellij.openapi.project.Project
import git4idea.commands.Git
import git4idea.commands.GitCommand
import git4idea.commands.GitLineHandler
import git4idea.repo.GitRepositoryManager

object DiffService {

    fun getStagedDiff(project: Project): String {
        val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            ?: return ""
        val handler = GitLineHandler(project, repo.root, GitCommand.DIFF)
        handler.addParameters("--cached", "--no-color")
        return Git.getInstance().runCommand(handler).output.joinToString("\n")
    }

    fun getRecentDiff(project: Project, commits: Int = 3): String {
        val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            ?: return ""
        // staged diff first
        val staged = getStagedDiff(project)
        // unstaged diff
        val unstagedHandler = GitLineHandler(project, repo.root, GitCommand.DIFF)
        unstagedHandler.addParameters("--no-color")
        val unstaged = Git.getInstance().runCommand(unstagedHandler).output.joinToString("\n")
        // recent commit log
        val logHandler = GitLineHandler(project, repo.root, GitCommand.LOG)
        logHandler.addParameters("--oneline", "-$commits")
        val log = Git.getInstance().runCommand(logHandler).output.joinToString("\n")
        return buildString {
            if (log.isNotBlank()) { appendLine("=== Recent commits ==="); appendLine(log) }
            if (staged.isNotBlank()) { appendLine("=== Staged changes ==="); appendLine(staged.take(3000)) }
            if (unstaged.isNotBlank()) { appendLine("=== Unstaged changes ==="); appendLine(unstaged.take(3000)) }
        }.trim()
    }

    fun getCommitHistory(project: Project, max: Int = 10): List<String> {
        val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            ?: return emptyList()
        val handler = GitLineHandler(project, repo.root, GitCommand.LOG)
        handler.addParameters("--oneline", "-$max")
        return Git.getInstance().runCommand(handler).output
    }
}
