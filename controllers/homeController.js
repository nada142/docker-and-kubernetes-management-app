const indexView = (req, res, next) =>{
    res.render('home');
}

const dockerfileView = (req, res, next) =>{
    res.render('dockerfile');
}

const dockerimgView = (req, res, next) =>{
    res.render('dockerimg');
}

const dockercontainersView = (req, res, next) =>{
    res.render('dockercontainers');
}
const loginView = (req, res, next) =>{
    res.render('login');
}
const registerView = (req, res, next) =>{
    res.render('register');
}
const profileView = (req, res, next) =>{
    res.render('profile');
}
const dockerfile_listView = (req, res, next) =>{
    res.render('dockerfile_list');
}
const add_containerView = (req, res, next) =>{
    res.render('add_container');
}
const volumesView = (req, res, next) =>{
    res.render('volumes');
}
const composeView = (req, res, next) =>{
    res.render('compose');
}
const serviceView = (req, res, next) =>{
    res.render('service');
}
const dockerRegistryView = (req, res, next) =>{
    res.render('dockerRegistries');
}
const dockerSwarmView = (req, res, next) =>{
    res.render('swarm_list');
}
const addStackView = (req, res, next) =>{
    res.render('add_stack');
}
const kubernetes_cluster_setupView = (req, res, next) =>{
    res.render('kubernetes_cluster_setup');
}
const kubernetes_nodesView = (req, res, next) =>{
    res.render('kubernetes_nodes');
}
const kubernetes_deploymentsView = (req, res, next) =>{
    res.render('kubernetes_deployments');
}
const kubernetes_servicesView = (req, res, next) =>{
    res.render('kubernetes_services');
}
const kubernetes_podsView = (req, res, next) =>{
    res.render('kubernetes_pods');
}
const kubernetes_pvcsView = (req, res, next) =>{
    res.render('kubernetes_pvcs');
}
const kubernetes_namespacesView = (req, res, next) =>{
    res.render('kubernetes_namespaces');
}

const kubernetes_configsView = (req, res, next) =>{
    res.render('kubernetes_configs');
}
const kubernetes_statefulsetsView = (req, res, next) =>{
    res.render('kubernetes_statefulsets');
}
const kubernetes_ingressesView = (req, res, next) =>{
    res.render('kubernetes_ingresses');
}
const cicdView = (req, res, next) =>{
    res.render('cicd_integration');
}
module.exports = {
    indexView,
    dockerfileView,
    dockerimgView,
    dockercontainersView,
    loginView,
    registerView,
    profileView,
    dockerfile_listView,
    add_containerView,
    volumesView,
    composeView,
    serviceView,
    dockerRegistryView,
    dockerSwarmView,
    addStackView,
    kubernetes_cluster_setupView,
    kubernetes_nodesView,
    kubernetes_deploymentsView,
    kubernetes_servicesView,
    kubernetes_podsView,
    kubernetes_pvcsView,
    kubernetes_namespacesView,
    kubernetes_configsView,
    kubernetes_statefulsetsView,
    kubernetes_ingressesView,
    cicdView

}