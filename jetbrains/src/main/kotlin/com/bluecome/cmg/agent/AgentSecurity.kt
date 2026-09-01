package com.bluecome.cmg.agent

import java.io.File

object AgentSecurity {

    val DANGEROUS_COMMAND_PATTERNS = listOf(
        Regex("\\brm\\s+-rf?\\s+(/|~|\\*|\\.)"),
        Regex("\\bmkfs\\b|\\bformat\\s+[A-Za-z]:", RegexOption.IGNORE_CASE),
        Regex("\\b(shutdown|reboot|poweroff)\\b", RegexOption.IGNORE_CASE),
        Regex("\\bdd\\s+if=.*of=/dev/(sd|hd)", RegexOption.IGNORE_CASE),
        Regex("\\bgit\\s+push\\b[^\\n]*--force\\b", RegexOption.IGNORE_CASE),
        Regex(">:?\\s*/dev/(sd|hd)", RegexOption.IGNORE_CASE),
        Regex("\\b(Remove-Item|rm|del|erase|rd|rmdir)\\b(?=[^\\n]*[A-Za-z]:[\\\\/])(?=[^\\n]*(?:/s\\b|-\\s*\\b(Recurse|R|Force|f)\\b))", RegexOption.IGNORE_CASE),
        Regex("\\bClear-Disk\\b", RegexOption.IGNORE_CASE),
        Regex("\\bFormat-Volume\\b", RegexOption.IGNORE_CASE)
    )

    fun isDangerousCommand(command: String): Boolean =
        DANGEROUS_COMMAND_PATTERNS.any { it.containsMatchIn(command) }

    /** canonicalPath 归一化 + Windows 大小写不敏感前缀匹配 */
    fun isWithinWorkspace(root: String, target: String): Boolean = try {
        val r = File(root).canonicalPath.lowercase()
        val t = File(target).canonicalPath.lowercase()
        t == r || t.startsWith(r + File.separator)
    } catch (_: Exception) { false }
}
