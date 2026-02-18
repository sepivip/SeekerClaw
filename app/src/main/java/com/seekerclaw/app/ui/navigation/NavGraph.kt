package com.seekerclaw.app.ui.navigation

import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import com.seekerclaw.app.ui.theme.RethinkSans
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
import com.seekerclaw.app.ui.system.SystemScreen
import com.seekerclaw.app.R
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import kotlinx.serialization.Serializable

// Route definitions
@Serializable object SetupRoute
@Serializable object DashboardRoute
@Serializable object LogsRoute
@Serializable object SettingsRoute
@Serializable object SystemRoute

data class BottomNavItem(
    val label: String,
    val iconRes: Int,
    val route: Any,
)

val bottomNavItems = listOf(
    BottomNavItem("Home", R.drawable.ic_lucide_layout_grid, DashboardRoute),
    BottomNavItem("Console", R.drawable.ic_lucide_terminal, LogsRoute),
    BottomNavItem("Settings", R.drawable.ic_lucide_settings, SettingsRoute),
)

@Composable
fun SeekerClawNavHost() {
    val context = LocalContext.current
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    // Track screen views
    DisposableEffect(navController) {
        val listener = androidx.navigation.NavController.OnDestinationChangedListener { _, dest, _ ->
            val screenName = when {
                dest.hasRoute(SetupRoute::class) -> "Setup"
                dest.hasRoute(DashboardRoute::class) -> "Dashboard"
                dest.hasRoute(LogsRoute::class) -> "Console"
                dest.hasRoute(SettingsRoute::class) -> "Settings"
                dest.hasRoute(SystemRoute::class) -> "System"
                else -> dest.route ?: "Unknown"
            }
            Analytics.logScreenView(screenName)
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose { navController.removeOnDestinationChangedListener(listener) }
    }

    val startDestination: Any = if (ConfigManager.isSetupComplete(context)) {
        DashboardRoute
    } else {
        SetupRoute
    }

    val showBottomBar = currentDestination?.let { dest ->
        bottomNavItems.any { item ->
            dest.hierarchy.any { it.hasRoute(item.route::class) }
        }
    } ?: false

    Scaffold(
        containerColor = SeekerClawColors.Background,
        bottomBar = {
            if (showBottomBar) {
                Column {
                    HorizontalDivider(
                        thickness = 1.dp,
                        color = SeekerClawColors.CardBorder,
                    )
                    NavigationBar(
                        containerColor = SeekerClawColors.Background,
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
                                        painter = painterResource(item.iconRes),
                                        contentDescription = item.label,
                                    )
                                },
                                label = {
                                    Text(
                                        text = item.label,
                                        fontFamily = RethinkSans,
                                        fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                                        fontSize = 11.sp,
                                    )
                                },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = SeekerClawColors.Primary,
                                    selectedTextColor = SeekerClawColors.Primary,
                                    unselectedIconColor = SeekerClawColors.TextDim,
                                    unselectedTextColor = SeekerClawColors.TextDim,
                                    indicatorColor = Color.Transparent,
                                ),
                            )
                        }
                    }
                }
            }
        },
    ) { innerPadding ->
        val fadeSpec = tween<Float>(durationMillis = 200)
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.padding(innerPadding),
            enterTransition = { fadeIn(animationSpec = fadeSpec) },
            exitTransition = { fadeOut(animationSpec = fadeSpec) },
            popEnterTransition = { fadeIn(animationSpec = fadeSpec) },
            popExitTransition = { fadeOut(animationSpec = fadeSpec) },
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
                DashboardScreen(
                    onNavigateToSystem = {
                        navController.navigate(SystemRoute)
                    },
                    onNavigateToSettings = {
                        navController.navigate(SettingsRoute) {
                            popUpTo(navController.graph.findStartDestination().id) {
                                saveState = true
                            }
                            launchSingleTop = true
                            restoreState = true
                        }
                    },
                )
            }
            composable<SystemRoute> {
                SystemScreen(
                    onBack = { navController.popBackStack() }
                )
            }
            composable<LogsRoute> {
                LogsScreen()
            }
            composable<SettingsRoute> {
                SettingsScreen(
                    onRunSetupAgain = {
                        navController.navigate(SetupRoute) {
                            popUpTo(navController.graph.findStartDestination().id) {
                                inclusive = true
                            }
                        }
                    }
                )
            }
        }
    }
}
