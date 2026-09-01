plugins {
    id("org.jetbrains.intellij.platform") version "2.1.0"
    kotlin("jvm") version "1.9.25"
}

group = "com.bluecome"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
        bundledPlugin("Git4Idea")
        pluginVerifier()
        instrumentationTools()
    }
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")
}

kotlin {
    jvmToolchain(17)
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "241"
            untilBuild = "251.*"
        }
    }
}
