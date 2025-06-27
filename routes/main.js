const express = require('express');
const { indexView, dockerfileView, dockerimgView, dockercontainersView, loginView, registerView,profileView,dockerfile_listView,add_containerView,volumesView,composeView,serviceView,dockerRegistryView,dockerSwarmView,addStackView,kubernetes_cluster_setupView,kubernetes_nodesView,kubernetes_deploymentsView,kubernetes_servicesView,kubernetes_podsView,kubernetes_pvcsView,kubernetes_namespacesView,kubernetes_configsView,kubernetes_statefulsetsView,kubernetes_ingressesView,cicdView} = require('../controllers/homeController');
const { buildImage, listImages, runContainer, listContainers, manageContainer } = require('../controllers/dockerController');
const { authenticateUser, registerUser } = require('../controllers/userController');

const router = express.Router();

router.get('/', indexView);
router.get('/dockerfile', dockerfileView);
router.get('/dockerimg', dockerimgView);
router.get('/dockercontainers', dockercontainersView);
router.get('/login', loginView);
router.get('/register', registerView);
router.get('/profile', profileView);
router.get('/dockerfile_list', dockerfile_listView);
router.get('/add_container', add_containerView);
router.get('/volumes', volumesView);
router.get('/compose', composeView);
router.get('/service', serviceView);
router.get('/dockerRegistries', dockerRegistryView);
router.get('/swarm_list', dockerSwarmView);
router.get('/add_stack', addStackView);
router.get('/kubernetes/cluster', kubernetes_cluster_setupView);
router.get('/kubernetes/nodes', kubernetes_nodesView);
router.get('/kubernetes/deployments', kubernetes_deploymentsView);
router.get('/kubernetes/services', kubernetes_servicesView);
router.get('/kubernetes/pods', kubernetes_podsView);
router.get('/kubernetes/pvcs', kubernetes_pvcsView);
router.get('/kubernetes/namespaces', kubernetes_namespacesView);
router.get('/kubernetes/configs', kubernetes_configsView);
router.get('/kubernetes/statefulsets', kubernetes_statefulsetsView);
router.get('/kubernetes/ingresses', kubernetes_ingressesView);

router.get('/cicd_integration', cicdView);

















module.exports = router;
