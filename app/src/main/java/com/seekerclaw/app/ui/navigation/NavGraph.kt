package com.seekerclaw.app.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.dashboard.DashboardScreen
import com.seekerclaw.app.ui.logs.LogsScreen
import com.seekerclaw.app.ui.settings.SettingsScreen
import com.seekerclaw.app.ui.setup.SetupScreen
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.serialization.Serializable

// Route definitions
@Serializable object SetupRoute
@Serializable object DashboardRoute
@Serializable object LogsRoute
@Serializable object SettingsRoute

data class BottomNavItem(
    val label: String,
    val icon: ImageVector,
    val route: Any,
)

val bottomNavItems = listOf(
    BottomNavItem("HOME", Icons.Default.Dashboard, DashboardRoute),
    BottomNavItem("CONSOLE", Icons.Default.Description, LogsRoute),
    BottomNavItem("CONFIG", Icons.Default.Settings, SettingsRoute),
)

@Composable
fun SeekerClawNavHost() {
    val context = LocalContext.current
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    // Skip setup if already configured
    val startDestination: Any = if (ConfigManager.isSetupComplete(context)) {
        DashboardRoute
    } else {
        SetupRoute
    }

    // Show bottom bar only on main screens (not Setup)
    val showBottomBar = currentDestination?.let { dest ->
        bottomNavItems.any { item ->
            dest.hierarchy.any { it.hasRoute(item.route::class) }
        }
    } ?: false

    Scaffold(
        containerColor = SeekerClawColors.Background,
        bottomBar = {
            if (showBottomBar) {
                NavigationBar(
                    containerColor = SeekerClawColors.Surface,
                    tonalElevation = 0.dp,
                ) {
                    bottomNavItems.forEach { item ->
                        val selected = currentDestination?.hierarchy?.any {
                            it.hasRoute(item.route::class)
                        } == true
                        NavigationBarItem(
                            selected = selected,
                            onClick = {
                                navController.navigate(item.route) {
                                    popUpTo(navController.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = {
                                Icon(
                                    item.icon,
                                    contentDescription = item.label,
                                )
                            },
                            label = {
                                Text(
                                    text = item.label,
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                    fontSize = 10.sp,
                                    letterSpacing = 1.sp,
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = SeekerClawColors.Primary,
                                selectedTextColor = SeekerClawColors.Primary,
                                unselectedIconColor = SeekerClawColors.TextDim,
                                unselectedTextColor = SeekerClawColors.TextDim,
                                indicatorColor = SeekerClawColors.PrimaryGlow,
                            ),
                        )
                    }
                }
            }
        },
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.padding(innerPadding),
        ) {
            composable<SetupRoute> {
                SetupScreen(
                    onSetupComplete = {
                        navController.navigate(DashboardRoute) {
                            popUpTo(SetupRoute) { inclusive = true }
                        }
                    }
                )
            }
            composable<DashboardRoute> {
                DashboardScreen()
            }
            composable<LogsRoute> {
                LogsScreen()
            }
            composable<SettingsRoute> {
                SettingsScreen()
            }
        }
    }
}
